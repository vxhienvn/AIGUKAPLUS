-- Admin-approved showroom promotion scanner.
-- Scans customers whose latest inbound is 30 minutes to 20 hours old,
-- have not provided phone/Zalo, have no pending AI/outbound work, and have
-- not already received this campaign. Runs every 10 minutes, 5 customers/run.

create table if not exists public.v8_promotion_scan_runs (
  id uuid primary key default gen_random_uuid(),
  campaign_key text not null,
  requested_by text,
  dry_run boolean not null default false,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  candidate_count integer not null default 0,
  staged_count integer not null default 0,
  skipped_count integer not null default 0,
  failed_count integer not null default 0,
  details jsonb not null default '{}'::jsonb
);

create index if not exists idx_v8_promotion_scan_runs_started
  on public.v8_promotion_scan_runs(started_at desc);

update public.v8_config_hub
set value=jsonb_build_object(
      'enabled',true,
      'min_age_minutes',30,
      'max_age_hours',20,
      'scan_interval_minutes',10,
      'batch_size',5,
      'oldest_first',true,
      'require_no_contact',true,
      'block_when_pending_ai',true,
      'block_when_pending_outbound',true,
      'requested_by','admin_approved_20h_promotion_scan'
    ),
    description='Scan customers without phone/Zalo from 30 minutes to 20 hours old; 5 customers every 10 minutes.',
    is_active=true,
    updated_at=now()
where scope='promotion' and key='showroom_event_202607_scan_20h';

insert into public.v8_config_hub(scope,key,value,description,is_active)
select 'promotion','showroom_event_202607_scan_20h',
       jsonb_build_object(
         'enabled',true,
         'min_age_minutes',30,
         'max_age_hours',20,
         'scan_interval_minutes',10,
         'batch_size',5,
         'oldest_first',true,
         'require_no_contact',true,
         'block_when_pending_ai',true,
         'block_when_pending_outbound',true,
         'requested_by','admin_approved_20h_promotion_scan'
       ),
       'Scan customers without phone/Zalo from 30 minutes to 20 hours old; 5 customers every 10 minutes.',
       true
where not exists(
  select 1 from public.v8_config_hub
  where scope='promotion' and key='showroom_event_202607_scan_20h'
);

create or replace function public.v8_scan_showroom_promotion_20h(
  p_limit integer default 5,
  p_dry_run boolean default false,
  p_requested_by text default 'cron_promotion_20h'
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_scan_cfg jsonb;
  v_promo_cfg jsonb;
  v_campaign_key text;
  v_min_age_minutes integer:=30;
  v_max_age_hours integer:=20;
  v_limit integer:=5;
  v_run_id uuid;
  v_result jsonb;
  v_results jsonb:='[]'::jsonb;
  v_candidates integer:=0;
  v_staged integer:=0;
  v_skipped integer:=0;
  v_failed integer:=0;
  r record;
begin
  if not pg_try_advisory_xact_lock(hashtext('v8_scan_showroom_promotion_20h')) then
    return jsonb_build_object('ok',true,'running',false,'reason','scan_already_running');
  end if;

  select value into v_scan_cfg
  from public.v8_config_hub
  where scope='promotion' and key='showroom_event_202607_scan_20h' and is_active
  order by updated_at desc limit 1;
  v_scan_cfg:=coalesce(v_scan_cfg,'{}'::jsonb);
  if not coalesce((v_scan_cfg->>'enabled')::boolean,false) then
    return jsonb_build_object('ok',true,'running',false,'reason','scan_disabled');
  end if;

  select value into v_promo_cfg
  from public.v8_config_hub
  where scope='promotion' and key='showroom_event_202607_full_carousel' and is_active
  order by updated_at desc limit 1;
  v_promo_cfg:=coalesce(v_promo_cfg,'{}'::jsonb);
  if not coalesce((v_promo_cfg->>'enabled')::boolean,false) then
    return jsonb_build_object('ok',true,'running',false,'reason','promotion_disabled');
  end if;

  v_campaign_key:=coalesce(nullif(v_promo_cfg->>'campaign_key',''),'showroom_event_202607_v1');
  v_min_age_minutes:=least(greatest(coalesce((v_scan_cfg->>'min_age_minutes')::integer,30),5),1200);
  v_max_age_hours:=least(greatest(coalesce((v_scan_cfg->>'max_age_hours')::integer,20),1),23);
  v_limit:=least(greatest(coalesce(p_limit,(v_scan_cfg->>'batch_size')::integer,5),1),20);

  insert into public.v8_promotion_scan_runs(campaign_key,requested_by,dry_run,details)
  values(v_campaign_key,p_requested_by,p_dry_run,jsonb_build_object(
    'min_age_minutes',v_min_age_minutes,
    'max_age_hours',v_max_age_hours,
    'batch_limit',v_limit,
    'human_reply_pre_filtered',true
  )) returning id into v_run_id;

  for r in
    with latest_inbound as (
      select distinct on (m.customer_id)
        m.customer_id,m.id as source_message_row_id,m.page_id,m.sender_id,m.sent_at,m.message_id
      from public.v8_messages_raw m
      where m.customer_id is not null
        and m.direction='inbound'
        and m.actor_type='customer'
      order by m.customer_id,m.sent_at desc,m.created_at desc
    )
    select c.id as customer_id,c.display_name,c.page_id,c.sender_id,
           li.source_message_row_id,li.sent_at as last_inbound_at,li.message_id
    from latest_inbound li
    join public.v8_customers c on c.id=li.customer_id
    where li.sent_at >= now()-make_interval(hours=>v_max_age_hours)
      and li.sent_at <= now()-make_interval(mins=>v_min_age_minutes)
      and exists(
        select 1 from jsonb_array_elements_text(coalesce(v_promo_cfg->'page_ids','[]'::jsonb)) p(value)
        where p.value=c.page_id
      )
      and not public.v8_customer_has_contact(c.id)
      and not exists(
        select 1 from public.v8_promotion_delivery_log d
        where d.customer_id=c.id and d.campaign_key=v_campaign_key
      )
      and not exists(
        select 1 from public.v8_marketing_message_subscriptions s
        where s.customer_id=c.id and s.page_id=c.page_id and s.status='stopped'
      )
      and not exists(
        select 1 from public.v8_outbound_queue q
        where q.customer_id=c.id and q.status in ('planned','ready','sending')
      )
      and not exists(
        select 1 from public.v8_ai_brain_requests a
        where a.page_id=c.page_id and a.sender_id=c.sender_id
          and a.status in ('pending','processing','claimed','running')
      )
      and not exists(
        select 1 from public.v8_ai_revision_requests ar
        where ar.customer_id=c.id and ar.status in ('pending','processing','claimed','running')
      )
      and not exists(
        select 1 from public.v8_messages_raw x
        where x.customer_id=c.id and x.direction='outbound' and x.sent_at>li.sent_at
          and (
            public.v8_is_actionable_external_outbound(x.source_system,x.message_text,x.attachments,x.is_automatic,x.actor_type,x.source_detail)
            or public.v8_is_unresolved_page_outbound_candidate(x.source_system,x.message_text,x.attachments,x.is_automatic,x.actor_type,x.source_detail)
          )
      )
    order by li.sent_at asc
    limit v_limit
  loop
    v_candidates:=v_candidates+1;
    begin
      v_result:=public.v8_stage_showroom_promotion(
        r.customer_id,
        r.source_message_row_id,
        p_requested_by,
        p_dry_run
      );
      if coalesce((v_result->>'staged')::boolean,false) then
        v_staged:=v_staged+1;
      else
        v_skipped:=v_skipped+1;
      end if;
      v_results:=v_results||jsonb_build_array(jsonb_build_object(
        'customer_id',r.customer_id,
        'display_name',r.display_name,
        'page_id',r.page_id,
        'last_inbound_at',r.last_inbound_at,
        'result',v_result
      ));
    exception when others then
      v_failed:=v_failed+1;
      v_results:=v_results||jsonb_build_array(jsonb_build_object(
        'customer_id',r.customer_id,
        'display_name',r.display_name,
        'page_id',r.page_id,
        'last_inbound_at',r.last_inbound_at,
        'error',sqlerrm
      ));
    end;
  end loop;

  update public.v8_promotion_scan_runs
  set completed_at=now(),candidate_count=v_candidates,staged_count=v_staged,
      skipped_count=v_skipped,failed_count=v_failed,
      details=details||jsonb_build_object('results',v_results)
  where id=v_run_id;

  return jsonb_build_object(
    'ok',v_failed=0,
    'run_id',v_run_id,
    'campaign_key',v_campaign_key,
    'dry_run',p_dry_run,
    'candidate_count',v_candidates,
    'staged_count',v_staged,
    'skipped_count',v_skipped,
    'failed_count',v_failed,
    'results',v_results
  );
end;
$$;

grant execute on function public.v8_scan_showroom_promotion_20h(integer,boolean,text) to service_role;

-- Keep AI-first architecture closed to legacy planners while allowing only the
-- verified opt-in campaign and this explicit admin-approved 20-hour campaign.
create or replace function public.v8_ai_guard_legacy_reply_plan()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_is_ai_plan boolean:=false;
  v_is_verified_marketing_plan boolean:=false;
  v_is_admin_20h_campaign boolean:=false;
begin
  v_is_admin_20h_campaign:=
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
    and coalesce(new.reason->>'source_system','') in ('meta_customer','meta_customer_history')
    and exists(
      select 1
      from public.v8_messages_raw m
      where m.page_id=new.page_id
        and m.customer_id=new.customer_id
        and m.message_id=new.message_id
        and m.direction='inbound'
        and m.actor_type='customer'
        and m.sent_at>=now()-interval '20 hours 5 minutes'
    );

  v_is_verified_marketing_plan:=
    coalesce(new.action_type,'')='promotion_carousel'
    and coalesce((new.reason->>'is_promotional')::boolean,false)
    and nullif(new.reason->>'promotion_delivery_id','') is not null
    and coalesce(new.pipeline_version,'')='promotion_v1'
    and (
      (
        coalesce(new.reason->>'source_system','')='meta_marketing_optin'
        and coalesce(new.reason->>'channel','')='notification_messages'
      )
      or v_is_admin_20h_campaign
    );

  v_is_ai_plan:=new.ai_decision_id is not null
    or coalesce((new.reason->>'ai_brain')::boolean,false)
    or nullif(new.reason->>'ai_decision_id','') is not null
    or nullif(new.reason->>'decision_id','') is not null
    or coalesce(new.action_type,'') in ('ai_reply','ai_clarification','ai_follow_up','ai_response')
    or v_is_verified_marketing_plan;

  if exists(select 1 from public.v8_ai_brain_runtime r where r.page_id=new.page_id and r.mode='ACTIVE')
     and not v_is_ai_plan then
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
$$;

do $$
declare v_jobid bigint;
begin
  for v_jobid in select jobid from cron.job where jobname='aiguka_v8_promotion_scan_20h'
  loop
    perform cron.unschedule(v_jobid);
  end loop;
  perform cron.schedule(
    'aiguka_v8_promotion_scan_20h',
    '*/10 * * * *',
    $cron$select public.v8_scan_showroom_promotion_20h(5,false,'cron_promotion_20h');$cron$
  );
end $$;
