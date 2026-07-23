-- AIGUKAPLUS AI quota optimization
-- Target: reduce AI spend by removing duplicate request paths, repeated tool rounds,
-- oversized context, follow-up AI scans, and late human-takeover checks.

alter table public.v8_ai_decisions
  add column if not exists prompt_version text,
  add column if not exists model_calls integer not null default 0,
  add column if not exists context_bytes integer,
  add column if not exists input_tokens bigint,
  add column if not exists output_tokens bigint,
  add column if not exists total_tokens bigint,
  add column if not exists cached_input_tokens bigint,
  add column if not exists reasoning_tokens bigint,
  add column if not exists usage_details jsonb;

create index if not exists idx_v8_ai_decisions_usage_created
  on public.v8_ai_decisions(created_at desc, prompt_version, model_name);

insert into public.v8_config_hub(scope,key,value,is_active,updated_at)
values(
  'runtime',
  'ai_quota_optimization',
  jsonb_build_object(
    'enabled',true,
    'version','evidence_first_single_call_v1',
    'target_cost_reduction_percent',90,
    'max_model_calls_per_turn',1,
    'max_history_messages',8,
    'max_relevant_contexts',2,
    'max_prompt_branches',2,
    'max_learning_cases',2,
    'max_catalog_candidates',5,
    'max_customer_images',2,
    'standard_model','gpt-5.4-mini',
    'premium_retry_enabled',false,
    'follow_up_ai_enabled',false,
    'history_can_trigger_ai',false,
    'measure_token_usage',true,
    'pre_model_human_reply_guard',true,
    'pre_model_contact_ack_guard',true,
    'pre_model_guard_version','pre_model_guard_v2_20260723',
    'activated_at',now()
  ),
  true,
  now()
)
on conflict(scope,key) do update
set value=excluded.value,is_active=true,updated_at=excluded.updated_at;

update public.v8_ai_brain_runtime
set model_name='gpt-5.4-mini',
    max_history_messages=8,
    max_tool_rounds=1,
    settings=coalesce(settings,'{}'::jsonb)||jsonb_build_object(
      'architecture','evidence_first_single_call_v1',
      'prompt_version','evidence_first_single_call_v1',
      'max_model_calls_per_turn',1,
      'premium_retry_enabled',false,
      'quota_target_reduction_percent',90,
      'actual_image_input_enabled',true,
      'usage_tracking_enabled',true
    ),
    updated_at=now();

update public.v8_config_hub
set value=coalesce(value,'{}'::jsonb)||jsonb_build_object(
      'enabled',false,
      'scheduler_enabled',false,
      'auto_send_enabled',false,
      'disabled_reason','evidence_first_quota_optimization',
      'disabled_at',now()
    ),
    updated_at=now()
where scope='conversation' and key='follow_up_policy' and is_active;

-- Remove the database follow-up scheduler. This is deliberately idempotent.
do $block$
begin
  if exists(select 1 from cron.job where jobname='aiguka_v8_follow_up_tasks') then
    perform cron.unschedule('aiguka_v8_follow_up_tasks');
  end if;
exception when insufficient_privilege then
  raise notice 'Cron unschedule requires an operational admin action';
end;
$block$;

-- Legacy/profile/follow-up/history requests are not allowed to retry into the new pipeline.
update public.v8_ai_brain_requests
set status='skipped',
    completed_at=now(),
    dispatch_locked_at=null,
    dispatch_locked_by=null,
    last_error='decommissioned_by_evidence_first_quota_optimization',
    dispatch_details=coalesce(dispatch_details,'{}'::jsonb)||jsonb_build_object(
      'quota_saved',true,
      'decommissioned_at',now(),
      'optimization_version','evidence_first_single_call_v1'
    )
where decision_id is null
  and status in ('pending','processing','error')
  and (
    requested_by in (
      'live_inbound_profile_preflight',
      'live_inbound_trigger',
      'follow_up_scan',
      'fresh_history_turn_debounced',
      'history_recovery_debounced'
    )
    or created_at<now()-interval '10 minutes'
  );

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
  -- A direct Sale/Admin reply after the customer turn makes the AI request unnecessary.
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
    and r.requested_by in (
      'live_inbound_debounced',
      'sla_recovery_latest_turn',
      'monitor_recovery_latest_turn'
    )
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

  -- Once contact has already been captured, a simple acknowledgement/waiting message
  -- becomes a zero-token Sale handoff instead of another AI decision.
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
        and public.v8_normalize_text(coalesce(src.message_text,''))
          ~ '(cam on|mong.*lien he|cho.*lien he|lien he som|goi lai som|doi.*tu van)'
        and coalesce(src.message_text,'') !~ '[?？]'
    );

  return query
  with picked as (
    select r.id
    from public.v8_ai_brain_requests r
    where r.status in ('pending','error','processing')
      and r.decision_id is null
      and coalesce(r.attempts,0)<2
      and r.requested_by in (
        'live_inbound_debounced',
        'sla_recovery_latest_turn',
        'monitor_recovery_latest_turn'
      )
      and (
        nullif(r.dispatch_details->>'not_before','') is null
        or (r.dispatch_details->>'not_before')::timestamptz<=now()
      )
      and (
        r.dispatch_locked_at is null
        or r.dispatch_locked_at<now()-interval '2 minutes'
      )
      and (
        r.status in ('pending','error')
        or r.started_at is null
        or r.started_at<now()-interval '2 minutes'
      )
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
    order by
      case when r.requested_by='live_inbound_debounced' then 0 else 1 end,
      r.created_at asc
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

create or replace view public.v8_ai_quota_daily as
select
  date_trunc('day',coalesce(completed_at,created_at)) as usage_day,
  coalesce(prompt_version,'legacy_unmeasured') as prompt_version,
  model_name,
  count(*) filter(where status='completed') as completed_decisions,
  sum(coalesce(model_calls,0)) as model_calls,
  sum(coalesce(input_tokens,0)) as input_tokens,
  sum(coalesce(output_tokens,0)) as output_tokens,
  sum(coalesce(total_tokens,0)) as total_tokens,
  sum(coalesce(cached_input_tokens,0)) as cached_input_tokens,
  avg(nullif(context_bytes,0))::numeric(14,2) as avg_context_bytes
from public.v8_ai_decisions
group by 1,2,3;
