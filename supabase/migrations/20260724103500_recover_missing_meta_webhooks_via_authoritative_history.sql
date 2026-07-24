-- Detect Meta webhook gaps from Pancake cache, recover authoritative Meta history,
-- and independently reconcile the AI delivery SLA every minute.

create or replace function public.v8_mark_meta_history_source_before_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(new.raw_payload->>'source','')='meta_history_sync'
     and new.direction='inbound'
     and coalesce(new.actor_type,'customer')='customer' then
    new.source_system:='meta_customer_history';
    new.actor_type:='customer';
    new.actor_name:=coalesce(nullif(new.actor_name,''),nullif(new.raw_payload->'from'->>'name',''),'Khách hàng');
    new.is_automatic:=false;
    new.actor_confidence:='high';
    new.source_detail:=coalesce(new.source_detail,'{}'::jsonb)||jsonb_build_object(
      'source','meta_history_sync',
      'classification','inbound_customer_history',
      'authoritative_meta_history',true
    );
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_v8_001_mark_meta_history_source on public.v8_messages_raw;
create trigger trg_v8_001_mark_meta_history_source
before insert or update of raw_payload,direction,actor_type,source_system
on public.v8_messages_raw
for each row execute function public.v8_mark_meta_history_source_before_write();

update public.v8_messages_raw
set source_system='meta_customer_history',
    actor_name=coalesce(nullif(actor_name,''),nullif(raw_payload->'from'->>'name',''),'Khách hàng'),
    is_automatic=false,
    actor_confidence='high',
    source_detail=coalesce(source_detail,'{}'::jsonb)||jsonb_build_object(
      'source','meta_history_sync',
      'classification','inbound_customer_history',
      'authoritative_meta_history',true,
      'normalized_at',now()
    )
where direction='inbound'
  and coalesce(actor_type,'customer')='customer'
  and coalesce(raw_payload->>'source','')='meta_history_sync'
  and coalesce(source_system,'')<>'meta_customer_history';

create or replace function public.v8_recover_missing_meta_webhooks_from_pancake(
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_locked boolean:=false;
  v_limit integer:=least(greatest(coalesce(p_limit,25),1),100);
  v_queued integer:=0;
begin
  select pg_try_advisory_xact_lock(hashtextextended('v8_missing_meta_webhook_recovery',0)) into v_locked;
  if not coalesce(v_locked,false) then
    return jsonb_build_object('ok',true,'skipped',true,'reason','recovery_already_running');
  end if;

  with candidates as (
    select pc.page_id,pc.customer_id as sender_id,pc.last_customer_message_at
    from public.v8_pancake_conversation_cache pc
    join public.v8_pages p on p.page_id=pc.page_id and p.is_active
    where pc.conversation->>'type'='INBOX'
      and pc.last_customer_message_at>=now()-interval '2 hours'
      and pc.last_customer_message_at<=now()-interval '45 seconds'
      and coalesce(pc.conversation->'last_sent_by'->>'id','')=pc.customer_id
      and not exists(
        select 1
        from public.v8_messages_raw m
        where m.page_id=pc.page_id
          and m.sender_id=pc.customer_id
          and m.direction='inbound'
          and coalesce(m.actor_type,'customer')='customer'
          and m.sent_at between pc.last_customer_message_at-interval '90 seconds'
                            and pc.last_customer_message_at+interval '90 seconds'
      )
      and not exists(
        select 1
        from public.v8_conversation_sync_queue q
        where q.page_id=pc.page_id and q.sender_id=pc.customer_id
          and (
            q.status='processing'
            or coalesce(q.last_requested_at,q.updated_at,q.created_at)>now()-interval '5 minutes'
          )
      )
    order by pc.last_customer_message_at
    limit v_limit
  ), upserted as (
    insert into public.v8_conversation_sync_queue(
      page_id,sender_id,priority,status,attempts,max_attempts,available_at,
      requested_scope,requested_by,last_requested_at,created_at,updated_at
    )
    select page_id,sender_id,0,'pending',0,5,now(),
           'conversation','pancake_gap_detector_meta_authoritative',now(),now(),now()
    from candidates
    on conflict(page_id,sender_id) do update set
      priority=0,
      status=case when public.v8_conversation_sync_queue.status='processing' then 'processing' else 'pending' end,
      attempts=case when public.v8_conversation_sync_queue.status='processing' then public.v8_conversation_sync_queue.attempts else 0 end,
      max_attempts=greatest(public.v8_conversation_sync_queue.max_attempts,5),
      available_at=case when public.v8_conversation_sync_queue.status='processing' then public.v8_conversation_sync_queue.available_at else now() end,
      requested_scope='conversation',
      requested_by='pancake_gap_detector_meta_authoritative',
      last_requested_at=now(),
      last_error=case when public.v8_conversation_sync_queue.status='processing' then public.v8_conversation_sync_queue.last_error else null end,
      updated_at=now()
    where public.v8_conversation_sync_queue.status<>'processing'
    returning 1
  )
  select count(*) into v_queued from upserted;

  return jsonb_build_object(
    'ok',true,
    'skipped',false,
    'queued_meta_history_sync',v_queued,
    'window','2 hours',
    'detector_source','pancake_cache',
    'recovery_source','authoritative_meta_history',
    'checked_at',now()
  );
end;
$function$;

create or replace function public.v8_reconcile_ai_delivery_sla(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_locked boolean:=false;
  v_limit integer:=least(greatest(coalesce(p_limit,100),1),500);
  v_missing_requests integer:=0;
  v_decisions_staged integer:=0;
  v_plans_recovered integer:=0;
  v_outbound_recovered integer:=0;
  v_request_id uuid;
  v_stage jsonb;
  v_row_count integer:=0;
  r record;
begin
  select pg_try_advisory_xact_lock(hashtextextended('v8_ai_delivery_sla_watchdog',0)) into v_locked;
  if not coalesce(v_locked,false) then
    return jsonb_build_object('ok',true,'skipped',true,'reason','watchdog_already_running');
  end if;

  for r in
    with latest as (
      select distinct on (m.page_id,m.sender_id)
        m.id,m.page_id,m.sender_id,m.customer_id,m.message_id,m.message_text,m.attachments,
        m.sent_at,m.created_at,m.source_system,m.raw_payload
      from public.v8_messages_raw m
      join public.v8_customers c on c.id=m.customer_id
      where m.direction='inbound'
        and coalesce(m.actor_type,'customer')='customer'
        and (
          coalesce(m.source_system,'') in ('meta_customer','meta_customer_history')
          or coalesce(m.raw_payload->>'source','')='meta_history_sync'
        )
        and m.sent_at>=now()-interval '2 hours'
      order by m.page_id,m.sender_id,m.sent_at desc,m.created_at desc,m.id desc
    )
    select l.*
    from latest l
    cross join lateral public.v8_resolve_runtime_policy(l.page_id) pol
    where l.sent_at<=now()-interval '60 seconds'
      and coalesce(pol.can_send_text,false)
      and (nullif(btrim(coalesce(l.message_text,'')),'') is not null
           or coalesce(jsonb_array_length(coalesce(l.attachments,'[]'::jsonb)),0)>0)
      and not exists(
        select 1 from public.v8_ai_brain_requests ar
        where ar.page_id=l.page_id and ar.message_id=l.message_id
          and ar.status in ('pending','processing','completed')
      )
      and not exists(select 1 from public.v8_ai_decisions ad where ad.page_id=l.page_id and ad.message_id=l.message_id)
      and not exists(
        select 1 from public.v8_messages_raw bo
        where bo.customer_id=l.customer_id and bo.direction='outbound' and bo.sent_at>=l.sent_at
          and coalesce(bo.source_system,'') in ('aiguka','aiguka_v8')
      )
      and not exists(
        select 1 from public.v8_messages_raw ho
        where ho.customer_id=l.customer_id and ho.direction='outbound' and ho.sent_at>=l.sent_at
          and public.v8_is_confirmed_human_outbound(
            ho.source_system,ho.message_text,ho.attachments,ho.is_automatic,ho.actor_type,ho.source_detail,ho.actor_app_id
          )
      )
      and not (
        coalesce(l.raw_payload->>'source','')='meta_history_sync'
        and (
          regexp_replace(coalesce(l.message_text,''),'[^0-9]','','g') ~ '^(0[0-9]{9,10}|84[0-9]{9,10})$'
          or exists(
            select 1
            from public.v8_pancake_conversation_cache pc
            where pc.page_id=l.page_id
              and pc.customer_id=l.sender_id
              and pc.conversation->>'type'='INBOX'
              and (
                lower(coalesce(pc.conversation->>'has_phone','false'))='true'
                or coalesce(pc.staff_tags,'{}'::text[]) && array['Zalo','Đã Gọi','Hẹn Ra CH']::text[]
              )
          )
        )
      )
    order by l.sent_at
    limit v_limit
  loop
    v_request_id:=public.v8_enqueue_ai_brain_request(r.page_id,r.sender_id,r.message_id,'sla_recovery_latest_turn');
    update public.v8_ai_brain_requests
    set status=case when status in ('skipped','error') then 'pending' else status end,
        requested_by='sla_recovery_latest_turn',dispatch_locked_at=null,dispatch_locked_by=null,
        completed_at=case when status in ('skipped','error') then null else completed_at end,
        last_error=case when status in ('skipped','error') then null else last_error end,
        dispatch_details=coalesce(dispatch_details,'{}'::jsonb)||jsonb_build_object(
          'sla_watchdog',true,'sla_stage','missing_ai_request','sla_recovered_at',now(),
          'not_before',now(),'source_message_row_id',r.id,'pipeline_version','unified_v1',
          'meta_history_recovery',coalesce(r.raw_payload->>'source','')='meta_history_sync'
        )
    where id=v_request_id;
    v_missing_requests:=v_missing_requests+1;
  end loop;

  for r in
    select d.id as decision_id,d.customer_id,d.completed_at
    from public.v8_ai_decisions d
    join public.v8_customers c on c.id=d.customer_id
    join public.v8_messages_raw m on m.page_id=d.page_id and m.message_id=d.message_id and m.customer_id=d.customer_id
    cross join lateral public.v8_resolve_runtime_policy(d.page_id) pol
    where d.status='completed' and d.should_reply
      and nullif(btrim(coalesce(d.final_reply,'')),'') is not null
      and d.completed_at<=now()-interval '20 seconds'
      and d.completed_at>=now()-interval '2 hours'
      and coalesce(pol.can_send_text,false)
      and not exists(select 1 from public.v8_reply_plans rp where rp.ai_decision_id=d.id)
      and not exists(
        select 1 from public.v8_messages_raw ni
        where ni.customer_id=d.customer_id and ni.direction='inbound' and ni.sent_at>m.sent_at
      )
      and not exists(
        select 1 from public.v8_messages_raw ho
        where ho.customer_id=d.customer_id and ho.direction='outbound' and ho.sent_at>=m.sent_at
          and public.v8_is_confirmed_human_outbound(
            ho.source_system,ho.message_text,ho.attachments,ho.is_automatic,ho.actor_type,ho.source_detail,ho.actor_app_id
          )
      )
    order by d.completed_at
    limit v_limit
  loop
    v_stage:=public.v8_ai_stage_decision(r.decision_id);
    if coalesce((v_stage->>'staged')::boolean,false) then v_decisions_staged:=v_decisions_staged+1; end if;
  end loop;

  for r in
    select rp.id as reply_plan_id,rp.ai_decision_id,rp.created_at
    from public.v8_reply_plans rp
    join public.v8_customers c on c.id=rp.customer_id
    where rp.ai_decision_id is not null
      and rp.pipeline_version in ('unified_v1','pre_unified_ai')
      and rp.created_at>=now()-interval '2 hours'
      and rp.created_at<=now()-interval '20 seconds'
      and coalesce(rp.dispatch_status,'not_staged')<>'sent'
      and not exists(
        select 1 from public.v8_outbound_queue oq
        where oq.reply_plan_id=rp.id and oq.status in ('ready','sending','sent')
      )
    order by rp.created_at
    limit v_limit
  loop
    v_stage:=public.v8_ai_stage_decision(r.ai_decision_id);
    if coalesce((v_stage->>'staged')::boolean,false) then v_plans_recovered:=v_plans_recovered+1; end if;
  end loop;

  update public.v8_outbound_queue
  set status=case when attempts>=max_attempts then 'failed' else 'ready' end,
      due_at=case when attempts>=max_attempts then due_at else now() end,
      locked_at=null,locked_by=null,authorized_at=null,authorized_by=null,
      authorization_version=null,authorization_details='{}'::jsonb,
      transport_confirmed_at=null,transport_confirmed_by=null,
      last_error=coalesce(last_error,'sla_stale_transport_lock_released'),updated_at=now()
  where status='sending' and locked_at<now()-interval '90 seconds';
  get diagnostics v_row_count=row_count;
  v_outbound_recovered:=v_row_count;

  return jsonb_build_object(
    'ok',true,'skipped',false,'checked_at',now(),'pipeline_version','unified_v1',
    'missing_requests_enqueued',v_missing_requests,
    'completed_decisions_staged',v_decisions_staged,
    'reply_plans_recovered',v_plans_recovered,
    'outbound_rows_recovered',v_outbound_recovered,
    'manual_pauses_cleared',0,
    'canonical_entrypoint','v8_ai_stage_decision'
  );
end;
$function$;

do $block$
declare v_job bigint;
begin
  for v_job in select jobid from cron.job where jobname='aiguka_v8_missing_webhook_recovery' loop
    perform cron.unschedule(v_job);
  end loop;
  for v_job in select jobid from cron.job where jobname='aiguka_v8_delivery_sla_reconcile' loop
    perform cron.unschedule(v_job);
  end loop;
  perform cron.schedule(
    'aiguka_v8_missing_webhook_recovery',
    '* * * * *',
    'select public.v8_recover_missing_meta_webhooks_from_pancake(25);'
  );
  perform cron.schedule(
    'aiguka_v8_delivery_sla_reconcile',
    '* * * * *',
    'select public.v8_reconcile_ai_delivery_sla(200);'
  );
end;
$block$;
