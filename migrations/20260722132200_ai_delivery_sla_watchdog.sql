-- AIGUKAPLUS: end-to-end AI delivery SLA watchdog
-- Structural fix for 20-30 minute gaps between inbound, AI decision, staging and Meta delivery.

create table if not exists public.v8_ai_delivery_sla_events(
  id uuid primary key default gen_random_uuid(),
  page_id text,
  sender_id text,
  customer_id uuid references public.v8_customers(id) on delete cascade,
  message_id text,
  entity_type text not null,
  entity_id uuid not null,
  stage text not null,
  action text not null,
  reason text,
  latency_seconds numeric,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(entity_type,entity_id,action)
);
create index if not exists idx_v8_ai_delivery_sla_events_created
  on public.v8_ai_delivery_sla_events(created_at desc);
create index if not exists idx_v8_ai_delivery_sla_events_customer
  on public.v8_ai_delivery_sla_events(customer_id,created_at desc);

-- A human pause belongs to the turn that the human answered. A new customer turn
-- must never inherit an older pause, regardless of stale actor metadata.
create or replace function public.v8_clear_pre_inbound_page_pause()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.direction='inbound' and new.actor_type='customer' and new.customer_id is not null then
    update public.v8_conversation_states
    set manual_pause_until=null,
        metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
          'stale_pre_inbound_pause_cleared',true,
          'stale_pre_inbound_pause_cleared_at',now(),
          'stale_pre_inbound_pause_cleared_by_message_id',new.message_id,
          'stale_pre_inbound_pause_previous_human_at',last_human_message_at
        ),updated_at=now()
    where customer_id=new.customer_id
      and manual_pause_until>now()
      and coalesce(last_human_message_at,'-infinity'::timestamptz)<new.sent_at;
  end if;
  return new;
end;
$function$;

-- Final safety guard: an unresolved Page response after the customer turn may be
-- a real Sale/Admin response. AI/SLA recovery must wait for positive actor resolution.
create or replace function public.v8_guard_ai_plan_on_unresolved_page_response()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_source_at timestamptz;
  v_has_unresolved boolean:=false;
begin
  if new.customer_id is null or new.message_id is null then return new; end if;
  if coalesce(new.reason->>'ai_brain','false')<>'true' then return new; end if;
  if not coalesce(new.send_eligible,false) and coalesce(new.safety_status,'')<>'ready_to_send' then return new; end if;
  select m.sent_at into v_source_at
  from public.v8_messages_raw m
  where m.page_id=new.page_id and m.message_id=new.message_id
  order by m.created_at desc limit 1;
  if v_source_at is null then return new; end if;
  select exists(
    select 1 from public.v8_messages_raw x
    where x.customer_id=new.customer_id and x.direction='outbound' and x.sent_at>=v_source_at
      and public.v8_is_unresolved_page_outbound_candidate(
        x.source_system,x.message_text,x.attachments,x.is_automatic,x.actor_type,x.source_detail
      )
  ) into v_has_unresolved;
  if v_has_unresolved then
    new.send_eligible:=false;
    new.safety_status:='suppressed_external_reply';
    new.blocked_reason:='unresolved_page_response';
    new.dispatch_status:='cancelled';
    new.reason:=coalesce(new.reason,'{}'::jsonb)||jsonb_build_object(
      'unresolved_page_response_guard',true,
      'unresolved_page_response_guard_at',now(),
      'sla_recovery_blocked',true,
      'requires_positive_actor_resolution',true
    );
  end if;
  return new;
end;
$function$;
drop trigger if exists trg_v8_zzzz_ai_unresolved_page_guard on public.v8_reply_plans;
create trigger trg_v8_zzzz_ai_unresolved_page_guard
before insert or update of send_eligible,safety_status,blocked_reason,reason
on public.v8_reply_plans
for each row execute function public.v8_guard_ai_plan_on_unresolved_page_response();

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
  v_stale_pauses_cleared integer:=0;
  v_request_id uuid;
  v_outbound public.v8_outbound_queue%rowtype;
  v_stage jsonb;
  v_rows integer:=0;
  r record;
begin
  select pg_try_advisory_xact_lock(hashtextextended('v8_ai_delivery_sla_watchdog',0)) into v_locked;
  if not coalesce(v_locked,false) then
    return jsonb_build_object('ok',true,'skipped',true,'reason','watchdog_already_running');
  end if;

  -- Receive -> AI request: recover a latest customer turn that never entered AI.
  for r in
    with latest as (
      select distinct on (m.page_id,m.sender_id)
        m.id,m.page_id,m.sender_id,m.customer_id,m.message_id,m.message_text,m.attachments,m.sent_at,m.created_at
      from public.v8_messages_raw m
      where m.direction='inbound' and coalesce(m.actor_type,'customer')='customer'
        and m.sent_at>=now()-interval '2 hours'
      order by m.page_id,m.sender_id,m.sent_at desc,m.created_at desc,m.id desc
    )
    select l.* from latest l
    cross join lateral public.v8_resolve_runtime_policy(l.page_id) pol
    where l.sent_at<=now()-interval '60 seconds' and coalesce(pol.can_send_text,false)
      and (nullif(btrim(coalesce(l.message_text,'')),'') is not null
           or coalesce(jsonb_array_length(coalesce(l.attachments,'[]'::jsonb)),0)>0)
      and not exists(select 1 from public.v8_ai_brain_requests ar
        where ar.page_id=l.page_id and ar.message_id=l.message_id
          and ar.status in ('pending','processing','completed'))
      and not exists(select 1 from public.v8_ai_decisions ad
        where ad.page_id=l.page_id and ad.message_id=l.message_id)
      and not exists(select 1 from public.v8_messages_raw bo
        where bo.customer_id=l.customer_id and bo.direction='outbound' and bo.sent_at>=l.sent_at
          and coalesce(bo.source_system,'') in ('aiguka','aiguka_v8'))
      and not exists(select 1 from public.v8_messages_raw ho
        where ho.customer_id=l.customer_id and ho.direction='outbound' and ho.sent_at>=l.sent_at
          and public.v8_is_confirmed_human_outbound(
            ho.source_system,ho.message_text,ho.attachments,ho.is_automatic,ho.actor_type,ho.source_detail,ho.actor_app_id))
    order by l.sent_at limit v_limit
  loop
    v_request_id:=public.v8_enqueue_ai_brain_request(r.page_id,r.sender_id,r.message_id,'sla_recovery_latest_turn');
    update public.v8_ai_brain_requests
    set status=case when status in ('skipped','error') then 'pending' else status end,
        requested_by='sla_recovery_latest_turn',dispatch_locked_at=null,dispatch_locked_by=null,
        completed_at=case when status in ('skipped','error') then null else completed_at end,
        last_error=case when status in ('skipped','error') then null else last_error end,
        dispatch_details=coalesce(dispatch_details,'{}'::jsonb)||jsonb_build_object(
          'sla_watchdog',true,'sla_stage','missing_ai_request','sla_recovered_at',now(),
          'not_before',now(),'source_message_row_id',r.id)
    where id=v_request_id;
    insert into public.v8_ai_delivery_sla_events(
      page_id,sender_id,customer_id,message_id,entity_type,entity_id,stage,action,reason,latency_seconds,details
    ) values(r.page_id,r.sender_id,r.customer_id,r.message_id,'message',r.id,
      'receive_to_ai_request','enqueue_ai_request','missing_request_after_60s',
      extract(epoch from (now()-r.sent_at)),jsonb_build_object('request_id',v_request_id))
    on conflict(entity_type,entity_id,action) do nothing;
    v_missing_requests:=v_missing_requests+1;
  end loop;

  -- AI decision -> reply plan: recover a completed decision not staged within 20s.
  for r in
    select d.id decision_id,d.page_id,d.sender_id,d.customer_id,d.message_id,d.completed_at,
           m.id message_row_id,m.sent_at source_at
    from public.v8_ai_decisions d
    join public.v8_messages_raw m on m.page_id=d.page_id and m.message_id=d.message_id
    cross join lateral public.v8_resolve_runtime_policy(d.page_id) pol
    where d.status='completed' and d.should_reply and nullif(btrim(coalesce(d.final_reply,'')),'') is not null
      and d.completed_at<=now()-interval '20 seconds' and d.completed_at>=now()-interval '2 hours'
      and coalesce(pol.can_send_text,false)
      and not exists(select 1 from public.v8_reply_plans rp where rp.reason->>'ai_decision_id'=d.id::text)
      and not exists(select 1 from public.v8_messages_raw ni
        where ni.customer_id=d.customer_id and ni.direction='inbound' and ni.sent_at>m.sent_at)
      and not exists(select 1 from public.v8_messages_raw bo
        where bo.customer_id=d.customer_id and bo.direction='outbound' and bo.sent_at>=m.sent_at
          and coalesce(bo.source_system,'') in ('aiguka','aiguka_v8'))
      and not exists(select 1 from public.v8_messages_raw ho
        where ho.customer_id=d.customer_id and ho.direction='outbound' and ho.sent_at>=m.sent_at
          and public.v8_is_confirmed_human_outbound(
            ho.source_system,ho.message_text,ho.attachments,ho.is_automatic,ho.actor_type,ho.source_detail,ho.actor_app_id))
    order by d.completed_at limit v_limit
  loop
    update public.v8_conversation_states
    set manual_pause_until=null,
        metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
          'sla_stale_pause_cleared',true,'sla_stale_pause_cleared_at',now(),
          'sla_source_message_id',r.message_id),updated_at=now()
    where customer_id=r.customer_id and manual_pause_until>now()
      and coalesce(last_human_message_at,'-infinity'::timestamptz)<r.source_at;
    get diagnostics v_rows=row_count;
    v_stale_pauses_cleared:=v_stale_pauses_cleared+v_rows;
    v_stage:=public.v8_ai_stage_decision(r.decision_id);
    if coalesce((v_stage->>'staged')::boolean,false) then v_decisions_staged:=v_decisions_staged+1; end if;
    insert into public.v8_ai_delivery_sla_events(
      page_id,sender_id,customer_id,message_id,entity_type,entity_id,stage,action,reason,latency_seconds,details
    ) values(r.page_id,r.sender_id,r.customer_id,r.message_id,'decision',r.decision_id,
      'decision_to_reply_plan','stage_decision','completed_decision_without_plan',
      extract(epoch from (now()-r.completed_at)),jsonb_build_object('stage_result',v_stage))
    on conflict(entity_type,entity_id,action) do nothing;
  end loop;

  -- Reply plan -> outbound: rebuild only an already-safe latest AI plan.
  for r in
    select rp.*,m.sent_at source_at
    from public.v8_reply_plans rp
    join public.v8_messages_raw m on m.page_id=rp.page_id and m.message_id=rp.message_id
    cross join lateral public.v8_resolve_runtime_policy(rp.page_id) pol
    where rp.created_at>=now()-interval '2 hours' and rp.created_at<=now()-interval '20 seconds'
      and rp.reason->>'ai_brain'='true' and rp.send_eligible and rp.safety_status='ready_to_send'
      and coalesce(rp.dispatch_status,'not_staged')<>'sent' and coalesce(pol.can_send_text,false)
      and not exists(select 1 from public.v8_messages_raw ni
        where ni.customer_id=rp.customer_id and ni.direction='inbound' and ni.sent_at>m.sent_at)
      and not exists(select 1 from public.v8_messages_raw bo
        where bo.customer_id=rp.customer_id and bo.direction='outbound' and bo.sent_at>=m.sent_at
          and coalesce(bo.source_system,'') in ('aiguka','aiguka_v8'))
      and not exists(select 1 from public.v8_messages_raw ho
        where ho.customer_id=rp.customer_id and ho.direction='outbound' and ho.sent_at>=m.sent_at
          and public.v8_is_confirmed_human_outbound(
            ho.source_system,ho.message_text,ho.attachments,ho.is_automatic,ho.actor_type,ho.source_detail,ho.actor_app_id))
    order by rp.created_at limit v_limit
  loop
    select * into v_outbound from public.v8_outbound_queue q
    where q.reply_plan_id=r.id order by q.created_at limit 1 for update;
    if v_outbound.id is null then
      v_stage:=public.v8_stage_reply_plan(r.id);
      v_plans_recovered:=v_plans_recovered+1;
    elsif v_outbound.status in ('planned','ready') then
      update public.v8_outbound_queue
      set status='ready',due_at=least(due_at,now()),last_error=null,updated_at=now()
      where id=v_outbound.id;
      v_outbound_recovered:=v_outbound_recovered+1;
      v_stage:=jsonb_build_object('ok',true,'outbound_id',v_outbound.id,'status','ready');
    else
      v_stage:=jsonb_build_object('ok',true,'outbound_id',v_outbound.id,'status',v_outbound.status,'changed',false);
    end if;
    insert into public.v8_ai_delivery_sla_events(
      page_id,sender_id,customer_id,message_id,entity_type,entity_id,stage,action,reason,latency_seconds,details
    ) values(r.page_id,r.sender_id,r.customer_id,r.message_id,'reply_plan',r.id,
      'reply_plan_to_outbound','recover_reply_plan','safe_latest_ai_plan_without_delivery',
      extract(epoch from (now()-r.created_at)),jsonb_build_object('stage_result',v_stage))
    on conflict(entity_type,entity_id,action) do nothing;
  end loop;

  update public.v8_outbound_queue
  set status=case when attempts>=max_attempts then 'failed' else 'ready' end,
      due_at=case when attempts>=max_attempts then due_at else now() end,
      locked_at=null,locked_by=null,authorized_at=null,authorized_by=null,
      authorization_version=null,authorization_details='{}'::jsonb,
      transport_confirmed_at=null,transport_confirmed_by=null,
      last_error=coalesce(last_error,'sla_stale_transport_lock_released'),updated_at=now()
  where status='sending' and locked_at<now()-interval '90 seconds';
  get diagnostics v_rows=row_count;
  v_outbound_recovered:=v_outbound_recovered+v_rows;

  return jsonb_build_object('ok',true,'skipped',false,'checked_at',now(),
    'missing_requests_enqueued',v_missing_requests,'completed_decisions_staged',v_decisions_staged,
    'reply_plans_recovered',v_plans_recovered,'outbound_rows_recovered',v_outbound_recovered,
    'stale_pauses_cleared',v_stale_pauses_cleared,
    'sla',jsonb_build_object('missing_request_seconds',60,'decision_stage_seconds',20,
      'reply_plan_delivery_seconds',20,'stale_transport_lock_seconds',90,'total_alert_seconds',120));
end;
$function$;

create or replace function public.v8_ai_delivery_sla_status()
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
with latest as (
  select distinct on (m.page_id,m.sender_id)
    m.id,m.page_id,m.sender_id,m.customer_id,m.message_id,m.sent_at
  from public.v8_messages_raw m
  where m.direction='inbound' and coalesce(m.actor_type,'customer')='customer'
    and m.sent_at>=now()-interval '2 hours'
  order by m.page_id,m.sender_id,m.sent_at desc,m.created_at desc,m.id desc
), delivery as (
  select l.*,
    (select min(x.sent_at) from public.v8_messages_raw x
      where x.customer_id=l.customer_id and x.direction='outbound' and x.sent_at>=l.sent_at
        and coalesce(x.source_system,'') in ('aiguka','aiguka_v8')) bot_sent_at,
    (select min(ar.created_at) from public.v8_ai_brain_requests ar
      where ar.page_id=l.page_id and ar.message_id=l.message_id) request_at,
    (select min(ad.completed_at) from public.v8_ai_decisions ad
      where ad.page_id=l.page_id and ad.message_id=l.message_id and ad.status='completed') decision_at,
    exists(select 1 from public.v8_messages_raw ho
      where ho.customer_id=l.customer_id and ho.direction='outbound' and ho.sent_at>=l.sent_at
        and public.v8_is_confirmed_human_outbound(
          ho.source_system,ho.message_text,ho.attachments,ho.is_automatic,ho.actor_type,ho.source_detail,ho.actor_app_id)) human_replied
  from latest l
), answered as (
  select extract(epoch from (bot_sent_at-sent_at)) latency_seconds from delivery where bot_sent_at is not null
)
select jsonb_build_object('generated_at',now(),'sla_target_seconds',120,
  'latest_customer_turns',(select count(*) from delivery),
  'unanswered_over_2m',(select count(*) from delivery where bot_sent_at is null and not human_replied and sent_at<now()-interval '2 minutes'),
  'missing_ai_request_over_60s',(select count(*) from delivery where request_at is null and not human_replied and sent_at<now()-interval '60 seconds'),
  'decision_without_delivery_over_30s',(select count(*) from delivery where decision_at is not null and bot_sent_at is null and not human_replied and decision_at<now()-interval '30 seconds'),
  'latency_seconds',jsonb_build_object(
    'p50',(select percentile_cont(.5) within group(order by latency_seconds) from answered),
    'p90',(select percentile_cont(.9) within group(order by latency_seconds) from answered),
    'max',(select max(latency_seconds) from answered)),
  'recoveries_last_2h',(select count(*) from public.v8_ai_delivery_sla_events where created_at>=now()-interval '2 hours'),
  'healthy',(select count(*)=0 from delivery where bot_sent_at is null and not human_replied and sent_at<now()-interval '2 minutes'));
$function$;

-- Run watchdog in both continuously polling workers. Advisory locking makes this safe.
create or replace function public.v8_claim_ai_dispatch_batch(p_worker text, p_batch_size integer default 5)
returns table(id uuid,page_id text,sender_id text,message_id text,requested_by text)
language plpgsql security definer set search_path to 'public'
as $function$
begin
  perform public.v8_reconcile_ai_delivery_sla(least(greatest(coalesce(p_batch_size,5)*10,50),200));
  return query
  with picked as (
    select r.id from public.v8_ai_brain_requests r
    where r.status in ('pending','error','processing') and r.decision_id is null and coalesce(r.attempts,0)<5
      and (nullif(r.dispatch_details->>'not_before','') is null or (r.dispatch_details->>'not_before')::timestamptz<=now())
      and (r.dispatch_locked_at is null or r.dispatch_locked_at<now()-interval '2 minutes')
      and (r.status in ('pending','error') or r.started_at is null or r.started_at<now()-interval '2 minutes')
      and (r.requested_by='follow_up_scan' or not exists(
        select 1 from public.v8_ai_brain_requests newer
        where newer.page_id=r.page_id and newer.sender_id=r.sender_id and newer.id<>r.id
          and newer.requested_by<>'follow_up_scan' and newer.decision_id is null
          and newer.status in ('pending','error','processing') and newer.created_at>r.created_at
          and newer.created_at<=r.created_at+interval '3 minutes'))
    order by case when r.requested_by='sla_recovery_latest_turn' then 0
      when r.requested_by='live_inbound_debounced' then 1
      when r.requested_by='fresh_history_turn_debounced' then 2
      when r.requested_by='live_inbound_profile_preflight' then 3 else 4 end,r.created_at
    for update skip locked limit least(greatest(coalesce(p_batch_size,5),1),10)
  ), upd as (
    update public.v8_ai_brain_requests r
    set status='processing',dispatch_locked_at=now(),dispatch_locked_by=p_worker,
        started_at=coalesce(r.started_at,now()),last_error=null
    from picked p where r.id=p.id
    returning r.id,r.page_id,r.sender_id,r.message_id,r.requested_by
  ) select * from upd;
end;
$function$;

create or replace function public.v8_claim_outbound_batch(p_worker_name text default 'v8-outbound-worker',p_batch_size integer default 10)
returns setof public.v8_outbound_queue
language plpgsql security definer set search_path to 'public'
as $function$
begin
  perform public.v8_reconcile_ai_delivery_sla(least(greatest(coalesce(p_batch_size,10)*10,100),300));
  perform public.v8_release_stale_outbound(2);
  perform public.v8_reconcile_ready_outbound_queue(least(greatest(coalesce(p_batch_size,10)*10,100),1000));
  return query
  with candidates as (
    select q.id from public.v8_outbound_queue q
    cross join lateral public.v8_evaluate_outbound_gate(q.id) gate
    where q.status='ready' and gate.allowed
    order by q.due_at,q.created_at for update of q skip locked
    limit least(greatest(coalesce(p_batch_size,10),1),50)
  )
  update public.v8_outbound_queue q
  set status='sending',attempts=q.attempts+1,locked_at=now(),locked_by=p_worker_name,
      authorized_at=null,authorized_by=null,authorization_version=null,authorization_details='{}'::jsonb,
      last_error=null,updated_at=now()
  from candidates c where q.id=c.id returning q.*;
end;
$function$;
