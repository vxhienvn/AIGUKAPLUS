-- Restore AI-authorized follow-up after customer silence.
-- Follow-up candidates are queued for a dedicated AI decision worker instead of
-- inserting legacy reply plans that are intentionally blocked by AI Brain.

create or replace function public.v8_claim_ai_dispatch_batch(
  p_worker text,
  p_batch_size integer default 5
)
returns table(
  id uuid,
  page_id text,
  sender_id text,
  message_id text,
  requested_by text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  return query
  with picked as (
    select r.id
    from public.v8_ai_brain_requests r
    where r.status in ('pending','error','processing')
      and r.decision_id is null
      and coalesce(r.attempts,0)<5
      and (
        r.dispatch_locked_at is null
        or r.dispatch_locked_at<now()-interval '2 minutes'
      )
      and (
        r.status in ('pending','error')
        or r.started_at is null
        or r.started_at<now()-interval '2 minutes'
      )
    order by r.created_at asc
    for update skip locked
    limit least(greatest(coalesce(p_batch_size,5),1),10)
  ), upd as (
    update public.v8_ai_brain_requests r
    set status='processing',
        dispatch_locked_at=now(),
        dispatch_locked_by=p_worker,
        started_at=coalesce(r.started_at,now()),
        last_error=null
    from picked p
    where r.id=p.id
    returning r.id,r.page_id,r.sender_id,r.message_id,r.requested_by
  )
  select * from upd;
end;
$function$;

create or replace function public.v8_create_follow_up_tasks(
  p_limit integer default 100,
  p_dry_run boolean default true,
  p_requested_by text default 'manual_test'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cfg jsonb:='{}'::jsonb;
  v_enabled boolean:=true;
  v_limit integer:=least(greatest(coalesce(p_limit,100),1),500);
  v_candidate_count integer:=0;
  v_requests_created integer:=0;
  v_row_count integer:=0;
  v_items jsonb:='[]'::jsonb;
  v_request_message_id text;
  r record;
begin
  select value into v_cfg
  from public.v8_config_hub
  where key='follow_up_policy' and scope='conversation' and is_active
  order by updated_at desc limit 1;

  v_enabled:=coalesce((v_cfg->>'enabled')::boolean,true);
  if not v_enabled then
    return jsonb_build_object(
      'enabled',false,'dry_run',p_dry_run,'candidates',0,
      'tasks_created',0,'ai_requests_created',0,'items','[]'::jsonb
    );
  end if;

  for r in
    with base as (
      select
        c.id as customer_id,c.page_id,c.sender_id,c.display_name,
        coalesce(q.product_key,c.last_product_key,rp0.business_group_key) as group_key,
        coalesce(bg.group_name,'sản phẩm') as group_name,
        c.last_intent_type,
        m_in.message_id as last_inbound_message_id,
        m_in.sent_at as last_inbound_at,
        q.intent_type as queue_intent_type,
        rp0.action_type as previous_action_type,
        rp0.conversation_stage as previous_stage,
        nullif(btrim(coalesce(rp0.suggested_reply,'')),'') as previous_reply,
        ext.last_external_at,
        ext.last_external_message_id,
        ext.sale_wait_hours,
        bot.last_bot_at,
        bot.last_bot_message_id,
        pol.runtime_mode
      from public.v8_customers c
      join public.v8_conversation_states s on s.customer_id=c.id
      join public.v8_messages_raw m_in
        on m_in.page_id=c.page_id and m_in.message_id=s.last_inbound_message_id
       and m_in.direction='inbound'
      join lateral public.v8_resolve_runtime_policy(c.page_id) pol on true
      left join lateral (
        select pq.*
        from public.v8_processing_queue pq
        where pq.page_id=c.page_id and pq.message_id=m_in.message_id
        order by pq.created_at desc limit 1
      ) q on true
      left join lateral (
        select rp.*
        from public.v8_reply_plans rp
        where rp.customer_id=c.id and rp.message_id=m_in.message_id
        order by rp.created_at desc limit 1
      ) rp0 on true
      left join public.v8_business_product_groups bg
        on bg.group_key=coalesce(q.product_key,c.last_product_key,rp0.business_group_key)
      left join lateral (
        select
          max(m.sent_at) as last_external_at,
          (array_agg(m.message_id order by m.sent_at desc))[1] as last_external_message_id,
          case
            when bool_or(public.v8_sale_reply_wait_hours(m.message_text,m.attachments)=8) then 8
            else greatest(1,max(public.v8_sale_reply_wait_hours(m.message_text,m.attachments)))
          end as sale_wait_hours
        from public.v8_messages_raw m
        where m.customer_id=c.id and m.direction='outbound'
          and m.sent_at>m_in.sent_at
          and public.v8_is_actionable_external_outbound(
            m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail
          )
      ) ext on true
      left join lateral (
        select
          max(m.sent_at) as last_bot_at,
          (array_agg(m.message_id order by m.sent_at desc))[1] as last_bot_message_id
        from public.v8_messages_raw m
        where m.customer_id=c.id and m.direction='outbound'
          and m.sent_at>m_in.sent_at
          and coalesce(m.source_system,'') in ('aiguka','aiguka_v8')
      ) bot on true
      where c.phone is null and c.zalo is null and not coalesce(s.has_phone,false)
        and m_in.sent_at>=now()-interval '24 hours'
        and coalesce(c.last_intent_type,'') not in (
          'provide_contact','decline','decline_contact','decline_interest','acknowledge'
        )
        and coalesce(pol.can_send_text,false)
    ), classified as (
      select b.*,
        case
          when b.last_external_at is null and b.last_bot_at is null then 'customer_unanswered'
          when b.last_bot_at is not null
               and (b.last_external_at is null or b.last_bot_at>=b.last_external_at) then 'bot_silence_8h'
          when b.last_external_at is not null
               and (b.last_bot_at is null or b.last_bot_at<b.last_external_at)
               and coalesce(b.sale_wait_hours,8)<8 then 'low_value_sale_takeover'
          when b.last_external_at is not null
               and (b.last_bot_at is null or b.last_bot_at<b.last_external_at) then 'sale_silence_8h'
          else null
        end as care_case,
        case
          when b.last_external_at is null and b.last_bot_at is null then b.last_inbound_at
          when b.last_bot_at is not null
               and (b.last_external_at is null or b.last_bot_at>=b.last_external_at) then b.last_bot_at
          else b.last_external_at
        end as care_anchor_at,
        case
          when b.last_external_at is null and b.last_bot_at is null then b.last_inbound_message_id
          when b.last_bot_at is not null
               and (b.last_external_at is null or b.last_bot_at>=b.last_external_at) then b.last_bot_message_id
          else b.last_external_message_id
        end as care_anchor_message_id,
        case
          when b.last_external_at is null and b.last_bot_at is null then b.last_inbound_at
          when b.last_bot_at is not null
               and (b.last_external_at is null or b.last_bot_at>=b.last_external_at)
            then b.last_bot_at+make_interval(hours=>least(greatest(coalesce((v_cfg->>'bot_silence_follow_up_hours')::integer,8),1),23))
          when coalesce(b.sale_wait_hours,8)<8 then b.last_external_at+make_interval(hours=>b.sale_wait_hours)
          else b.last_external_at+interval '8 hours'
        end as due_at
      from base b
    )
    select x.*
    from classified x
    where x.care_case is not null and x.due_at<=now()
      and not exists(
        select 1 from public.v8_outbound_queue oq
        where oq.customer_id=x.customer_id and oq.status in ('planned','ready','sending')
      )
    order by x.due_at,x.last_inbound_at
    limit v_limit
  loop
    v_request_message_id:='care:'||r.customer_id::text||':'||md5(coalesce(r.care_anchor_message_id,'')||':'||r.care_case);
    v_candidate_count:=v_candidate_count+1;
    v_items:=v_items||jsonb_build_array(jsonb_build_object(
      'customer_id',r.customer_id,'page_id',r.page_id,'sender_id',r.sender_id,
      'display_name',r.display_name,'care_case',r.care_case,
      'last_inbound_message_id',r.last_inbound_message_id,
      'last_inbound_at',r.last_inbound_at,'care_anchor_at',r.care_anchor_at,
      'care_anchor_message_id',r.care_anchor_message_id,
      'due_at',r.due_at,'sale_wait_hours',r.sale_wait_hours,
      'group_key',r.group_key,'group_name',r.group_name,
      'ai_request_message_id',v_request_message_id
    ));

    if not p_dry_run then
      insert into public.v8_ai_brain_requests(
        page_id,sender_id,message_id,status,requested_by,dispatch_details
      ) values(
        r.page_id,r.sender_id,v_request_message_id,'pending','follow_up_scan',
        jsonb_build_object(
          'trigger_type','follow_up',
          'care_case',r.care_case,
          'care_anchor_at',r.care_anchor_at,
          'care_anchor_message_id',r.care_anchor_message_id,
          'last_inbound_message_id',r.last_inbound_message_id,
          'last_inbound_at',r.last_inbound_at,
          'sale_reply_wait_hours',r.sale_wait_hours,
          'group_key',r.group_key,
          'group_name',r.group_name,
          'due_at',r.due_at,
          'requested_by',coalesce(nullif(p_requested_by,''),'system'),
          'policy',v_cfg
        )
      )
      on conflict(page_id,message_id) do nothing;
      get diagnostics v_row_count=row_count;
      v_requests_created:=v_requests_created+v_row_count;
    end if;
  end loop;

  return jsonb_build_object(
    'enabled',true,'dry_run',p_dry_run,'requested_by',p_requested_by,
    'scan_interval_minutes',10,'customer_unanswered_action','ai_decision_on_scan',
    'bot_silence_follow_up_hours',least(greatest(coalesce((v_cfg->>'bot_silence_follow_up_hours')::integer,8),1),23),
    'sale_silence_follow_up_hours',8,'low_value_sale_follow_up_hours','1-2',
    'lookback_hours',24,'limit',v_limit,'candidates',v_candidate_count,
    'tasks_created',0,'reply_plans_created',0,'ai_requests_created',v_requests_created,'items',v_items
  );
end;
$function$;

update public.v8_config_hub
set value=coalesce(value,'{}'::jsonb)||jsonb_build_object(
  'bot_silence_follow_up_hours',8,
  'decision_authority','ai_follow_up_brain',
  'follow_up_after_bot_reply',true
),updated_at=now()
where key='follow_up_policy' and scope='conversation' and is_active;
