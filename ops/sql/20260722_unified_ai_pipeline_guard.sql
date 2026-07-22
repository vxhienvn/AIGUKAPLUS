-- AIGUKA unified pipeline production guard
-- Applied live on Supabase project ezygfpeeqbbirdeazene on 2026-07-22.
-- This guard is intentionally idempotent. It removes deprecated topology and
-- fails loudly if the canonical unified_v1 functions are missing.

begin;

alter table public.v8_reply_plans
  add column if not exists ai_decision_id uuid references public.v8_ai_decisions(id) on delete set null,
  add column if not exists pipeline_version text not null default 'legacy';

alter table public.v8_slide_logs
  add column if not exists ai_decision_id uuid references public.v8_ai_decisions(id) on delete set null,
  add column if not exists pipeline_version text not null default 'legacy';

alter table public.v8_outbound_queue
  add column if not exists ai_decision_id uuid references public.v8_ai_decisions(id) on delete set null,
  add column if not exists pipeline_version text not null default 'legacy';

create unique index if not exists uq_v8_reply_plan_ai_decision
  on public.v8_reply_plans(ai_decision_id)
  where ai_decision_id is not null;

create unique index if not exists uq_v8_slide_ai_decision_asset
  on public.v8_slide_logs(ai_decision_id,asset_id)
  where ai_decision_id is not null and asset_id is not null;

create index if not exists idx_v8_outbound_ai_decision
  on public.v8_outbound_queue(ai_decision_id,created_at desc)
  where ai_decision_id is not null;

-- Deprecated paths: never recreate these triggers.
drop trigger if exists trg_v8_stage_outbound_from_reply_plan on public.v8_reply_plans;
drop trigger if exists trg_v8_stage_outbound_from_slide on public.v8_slide_logs;
drop trigger if exists trg_v8_cancel_outbound_on_conversation_activity on public.v8_messages_raw;
drop trigger if exists trg_v8_clear_pre_inbound_page_pause on public.v8_messages_raw;
drop trigger if exists trg_v8_zzzz_ai_unresolved_page_guard on public.v8_reply_plans;

-- Deprecated deterministic reply planner: remove its schedule when pg_cron is available.
do $cron$
begin
  if exists(select 1 from pg_namespace where nspname='cron') then
    begin
      perform cron.unschedule('aiguka_v8_reply_planner');
    exception when others then
      null;
    end;
  end if;
end;
$cron$;

create or replace function public.v8_build_reply_plans(
  p_started timestamptz default now()-interval '5 minutes'
)
returns jsonb
language sql
security definer
set search_path='public'
as $$
  select jsonb_build_object(
    'reply_plans_created',0,
    'decommissioned',true,
    'reason','legacy_template_reply_planner_removed',
    'canonical_entrypoint','v8_ai_stage_decision',
    'requested_since',p_started
  );
$$;

insert into public.v8_config_hub(scope,key,value,description,is_active,updated_at)
values(
  'runtime','unified_ai_pipeline',
  jsonb_build_object(
    'version','unified_v1',
    'activated_at',coalesce(
      (select nullif(value->>'activated_at','')::timestamptz
       from public.v8_config_hub
       where scope='runtime' and key='unified_ai_pipeline'),
      now()
    ),
    'canonical_entrypoint','v8_ai_stage_decision',
    'canonical_reply_stage','v8_stage_reply_plan',
    'canonical_slide_stage','v8_stage_slide_log',
    'canonical_final_gate','v8_authorize_outbound_send',
    'legacy_reply_planner','removed',
    'automatic_reply_plan_stage_trigger','removed',
    'automatic_slide_stage_trigger','removed',
    'duplicate_cancel_trigger','removed',
    'unknown_page_immediate_guard','removed',
    'pre_inbound_pause_clearer','removed'
  ),
  'Một pipeline duy nhất cho AI chính, follow-up và recovery.',
  true,now()
)
on conflict(scope,key) do update set
  value=excluded.value,
  description=excluded.description,
  is_active=true,
  updated_at=now();

-- Canonical function assertions. These checks stop an old deployment from
-- silently restoring parallel/legacy paths.
do $assert$
declare
  v_stage text;
  v_reply text;
  v_slide text;
  v_recovery text;
  v_sla text;
  v_actor text;
begin
  select pg_get_functiondef('public.v8_ai_stage_decision(uuid)'::regprocedure) into v_stage;
  select pg_get_functiondef('public.v8_stage_reply_plan(uuid)'::regprocedure) into v_reply;
  select pg_get_functiondef('public.v8_stage_slide_log(uuid)'::regprocedure) into v_slide;
  select pg_get_functiondef('public.v8_recover_ai_reply_after_automation_reclassification(uuid)'::regprocedure) into v_recovery;
  select pg_get_functiondef('public.v8_reconcile_ai_delivery_sla(integer)'::regprocedure) into v_sla;
  select pg_get_functiondef('public.v8_track_message_activity()'::regprocedure) into v_actor;

  if position('unified_v1' in v_stage)=0 then
    raise exception 'UNIFIED_PIPELINE_MISSING: v8_ai_stage_decision';
  end if;
  if position('unified_v1' in v_reply)=0 then
    raise exception 'UNIFIED_PIPELINE_MISSING: v8_stage_reply_plan';
  end if;
  if position('single_catalog' in v_slide)=0
     or position('mixed_catalog_carousel_forbidden' in v_slide)=0 then
    raise exception 'UNIFIED_PIPELINE_MISSING: v8_stage_slide_log';
  end if;
  if position('v8_ai_stage_decision' in v_recovery)=0 then
    raise exception 'RECOVERY_BYPASSES_CANONICAL_STAGE';
  end if;
  if position('canonical_entrypoint' in v_sla)=0
     or position('manual_pauses_cleared' in v_sla)=0 then
    raise exception 'SLA_WATCHDOG_BYPASSES_CANONICAL_STAGE';
  end if;
  if position('delayed_human_cluster' in v_actor)=0
     or position('late_automation_reversible_seconds' in v_actor)=0 then
    raise exception 'ACTOR_SETTLEMENT_POLICY_MISSING';
  end if;
end;
$assert$;

-- Configuration assertions for both production Pages.
do $config$
declare
  v_bad integer;
  v_pause_unknown boolean;
begin
  select count(*) into v_bad
  from public.v8_page_messaging_capabilities
  where page_id in ('104810069068200','985632314640803')
    and (coalesce(automation_grace_seconds,-1)<>18
         or coalesce(automation_pause_seconds,-1)<>0);
  if v_bad>0 then
    raise exception 'ACTOR_CONFIG_INVALID: grace must be 18 and automation pause must be 0';
  end if;

  select coalesce((value->>'pause_on_unknown_outbound_source')::boolean,false)
  into v_pause_unknown
  from public.v8_config_hub
  where scope='conversation' and key='human_handoff_policy' and is_active
  order by updated_at desc limit 1;
  if coalesce(v_pause_unknown,false) then
    raise exception 'ACTOR_CONFIG_INVALID: unknown outbound may not create pause';
  end if;
end;
$config$;

commit;

-- Post-deployment checks:
-- select public.v8_unified_pipeline_health();
-- select public.v8_regression_test_unified_pipeline();
-- select public.v8_regression_test_all_catalog_slides();
