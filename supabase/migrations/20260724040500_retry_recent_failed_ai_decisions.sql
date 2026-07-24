-- AIGUKAPLUS: retry one recent transient AI failure without replaying old conversations.
-- Root cause: aiguka-v8-ai-brain creates the decision row before the provider call.
-- On provider failure the request keeps decision_id, while the dispatcher previously
-- selected only requests where decision_id is null. The failed customer turn was
-- therefore stranded permanently.

create or replace function public.v8_claim_ai_dispatch_batch(
  p_worker text,
  p_batch_size integer default 5
)
returns table(id uuid,page_id text,sender_id text,message_id text,requested_by text)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.v8_ai_brain_requests r
  set status='skipped',
      completed_at=now(),
      dispatch_locked_at=null,
      dispatch_locked_by=null,
      last_error='direct_human_reply_before_model_call',
      dispatch_details=coalesce(r.dispatch_details,'{}'::jsonb)||jsonb_build_object(
        'quota_saved',true,
        'pre_model_guard','direct_human_reply_v2',
        'guarded_at',now()
      )
  where r.status in ('pending','error','processing')
    and r.decision_id is null
    and r.requested_by in ('live_inbound_debounced','sla_recovery_latest_turn','monitor_recovery_latest_turn')
    and exists (
      select 1
      from public.v8_messages_raw src
      join public.v8_messages_raw o
        on o.page_id=src.page_id
       and o.sender_id=src.sender_id
       and o.direction='outbound'
       and o.sent_at>src.sent_at
      where src.page_id=r.page_id
        and src.message_id=r.message_id
        and (
          coalesce(o.actor_type,'') in ('human_admin','sale','admin','staff')
          or (
            coalesce(o.source_system,'') ~* '(human|admin|sale|pancake)'
            and coalesce(o.source_system,'') !~* '(automation|botcake|aicake|aiguka|system)'
          )
        )
    );

  update public.v8_ai_brain_requests r
  set status='skipped',
      completed_at=now(),
      dispatch_locked_at=null,
      dispatch_locked_by=null,
      last_error='contact_handoff_ack_no_model',
      dispatch_details=coalesce(r.dispatch_details,'{}'::jsonb)||jsonb_build_object(
        'quota_saved',true,
        'handoff_sale',true,
        'pre_model_guard','contact_handoff_ack_v1',
        'guarded_at',now()
      )
  where r.status in ('pending','error','processing')
    and r.decision_id is null
    and r.requested_by='live_inbound_debounced'
    and exists (
      select 1
      from public.v8_messages_raw src
      left join public.v8_customers c
        on c.page_id=src.page_id and c.sender_id=src.sender_id
      left join public.v8_conversation_states s
        on s.customer_id=c.id
      where src.page_id=r.page_id
        and src.message_id=r.message_id
        and (c.phone is not null or c.zalo is not null or coalesce(s.has_phone,false))
        and public.v8_normalize_detector_text(coalesce(src.message_text,'')) ~ '(cam on|mong.*lien he|cho.*lien he|lien he som|goi lai som|doi.*tu van)'
        and coalesce(src.message_text,'') !~ '[?？]'
    );

  return query
  with picked as (
    select r.id
    from public.v8_ai_brain_requests r
    where r.status in ('pending','error','processing')
      and (
        r.decision_id is null
        or (
          r.created_at>=now()-interval '2 hours'
          and exists (
            select 1
            from public.v8_ai_decisions d
            where d.id=r.decision_id
              and d.status='error'
          )
        )
      )
      and coalesce(r.attempts,0)<2
      and r.requested_by in ('live_inbound_debounced','sla_recovery_latest_turn','monitor_recovery_latest_turn')
      and (
        nullif(r.dispatch_details->>'not_before','') is null
        or (r.dispatch_details->>'not_before')::timestamptz<=now()
      )
      and (r.dispatch_locked_at is null or r.dispatch_locked_at<now()-interval '2 minutes')
      and (r.status in ('pending','error') or r.started_at is null or r.started_at<now()-interval '2 minutes')
      and not exists(
        select 1
        from public.v8_ai_brain_requests newer
        where newer.page_id=r.page_id
          and newer.sender_id=r.sender_id
          and newer.id<>r.id
          and newer.requested_by='live_inbound_debounced'
          and newer.decision_id is null
          and newer.status in ('pending','error','processing')
          and newer.created_at>r.created_at
          and newer.created_at<=r.created_at+interval '3 minutes'
      )
    order by case when r.requested_by='live_inbound_debounced' then 0 else 1 end,r.created_at asc
    for update skip locked
    limit least(greatest(coalesce(p_batch_size,5),1),10)
  ), upd as (
    update public.v8_ai_brain_requests r
    set status='processing',
        completed_at=case when r.status='error' then null else r.completed_at end,
        dispatch_locked_at=now(),
        dispatch_locked_by=p_worker,
        started_at=case when r.status='error' then now() else coalesce(r.started_at,now()) end,
        last_error=null,
        dispatch_details=coalesce(r.dispatch_details,'{}'::jsonb)||
          case when r.decision_id is not null then jsonb_build_object(
            'error_retry_enabled',true,
            'error_retry_claimed_at',now(),
            'error_retry_window','2 hours',
            'error_retry_max_attempts',2
          ) else '{}'::jsonb end
    from picked p
    where r.id=p.id
    returning r.id,r.page_id,r.sender_id,r.message_id,r.requested_by
  )
  select * from upd;
end;
$function$;
