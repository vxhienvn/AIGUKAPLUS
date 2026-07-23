create table if not exists public.v8_promotion_scan_runs(
  id uuid primary key default gen_random_uuid(),
  campaign_key text not null,
  requested_by text not null,
  dry_run boolean not null default false,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  candidate_count integer not null default 0,
  staged_count integer not null default 0,
  skipped_count integer not null default 0,
  failed_count integer not null default 0,
  details jsonb not null default '{}'::jsonb
);

create index if not exists idx_v8_promotion_scan_runs_started_at
  on public.v8_promotion_scan_runs(started_at desc);

create or replace function public.v8_ai_guard_legacy_reply_plan()
returns trigger
language plpgsql
set search_path='public'
as $function$
declare
  v_is_ai_plan boolean:=false;
  v_is_verified_marketing_plan boolean:=false;
  v_is_standard_window_campaign boolean:=false;
begin
  v_is_standard_window_campaign:=
    coalesce(new.action_type,'')='promotion_carousel'
    and coalesce((new.reason->>'is_promotional')::boolean,false)
    and nullif(new.reason->>'promotion_delivery_id','') is not null
    and coalesce(new.pipeline_version,'')='promotion_v1'
    and coalesce(new.reason->>'channel','')='standard_24h'
    and coalesce(new.reason->>'requested_by','') in (
      'cron_promotion_20h',
      'initial_manual_run_after_validation',
      'admin_approved_20h_promotion_scan'
    )
    and exists(
      select 1
      from public.v8_messages_raw m
      where m.page_id=new.page_id
        and m.sender_id=new.sender_id
        and m.message_id=new.message_id
        and m.direction='inbound'
        and m.actor_type='customer'
        and m.sent_at between now()-interval '20 hours' and now()-interval '30 minutes'
    );

  v_is_verified_marketing_plan:=(
    coalesce(new.action_type,'')='promotion_carousel'
    and coalesce((new.reason->>'is_promotional')::boolean,false)
    and nullif(new.reason->>'promotion_delivery_id','') is not null
    and coalesce(new.pipeline_version,'')='promotion_v1'
    and (
      (
        coalesce(new.reason->>'source_system','')='meta_marketing_optin'
        and coalesce(new.reason->>'channel','notification_messages')='notification_messages'
      )
      or v_is_standard_window_campaign
    )
  );

  v_is_ai_plan:=new.ai_decision_id is not null
    or coalesce((new.reason->>'ai_brain')::boolean,false)
    or nullif(new.reason->>'ai_decision_id','') is not null
    or nullif(new.reason->>'decision_id','') is not null
    or coalesce(new.action_type,'') in ('ai_reply','ai_clarification','ai_follow_up','ai_response')
    or v_is_verified_marketing_plan;

  if exists(
      select 1 from public.v8_ai_brain_runtime r
      where r.page_id=new.page_id and r.mode='ACTIVE'
    ) and not v_is_ai_plan then
    new.send_eligible:=false;
    new.safety_status:='suppressed_ai_brain_active';
    new.blocked_reason:='legacy_reply_engine_disabled';
    new.action_type:='legacy_disabled_by_ai_brain';
    new.suggested_reply:='';
    new.dispatch_status:='cancelled';
    new.pipeline_version:='legacy_blocked';
  end if;
  return new;
end;
$function$;
