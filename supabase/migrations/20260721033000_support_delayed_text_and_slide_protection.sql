-- AIGUKA: SUPPORT mode sends requested slides immediately and only takes over text
-- after the configured Sale wait time. Also keeps V7 ask-sample slide protection
-- even when delayed text takeover is enabled.

update public.v8_config_hub
set value = coalesce(value,'{}'::jsonb) || jsonb_build_object(
      'aiguka_general_text_enabled', true,
      'text_reply_owner', 'aiguka_after_support_delay',
      'version', 'v7_slide_request_delivery_v2'
    ),
    updated_at = now()
where key='v7_slide_request_policy'
  and scope='page:104810069068200'
  and is_active;

create or replace function public.v8_resolve_runtime_policy(p_page_id text)
returns table(
  runtime_mode text,
  page_mode text,
  can_send_text boolean,
  can_send_image boolean,
  can_create_sale_task boolean,
  policy_source jsonb
)
language sql
stable
security definer
set search_path to 'public'
as $function$
with global_cfg as (
  select coalesce((
    select value
    from public.v8_config_hub
    where key='runtime_mode' and scope='global' and is_active
    order by updated_at desc
    limit 1
  ),jsonb_build_object(
    'mode','OBSERVE',
    'aiguka_can_send_text',false,
    'aiguka_can_send_image',false,
    'aiguka_can_create_sale_task',true
  )) as value
), page_cfg as (
  select coalesce((
    select case
      when upper(coalesce(bot_mode,'OBSERVE'))='LIVE' then 'PRODUCTION'
      when upper(coalesce(bot_mode,'OBSERVE')) in ('ASSIST','SALE_SUPPORT','SLIDE_ONLY') then 'SUPPORT'
      else upper(coalesce(bot_mode,'OBSERVE'))
    end
    from public.v8_pages
    where page_id=p_page_id and is_active
    limit 1
  ),'OBSERVE') as mode
), support_cfg as (
  select
    coalesce((
      select support_config
      from public.bot_working_settings
      where setting_key='default'
      order by updated_at desc
      limit 1
    ),'{}'::jsonb) as value,
    least(greatest(coalesce((
      select support_reply_delay_minutes
      from public.bot_working_settings
      where setting_key='default'
      order by updated_at desc
      limit 1
    ),10),0),120) as reply_delay_minutes
), schedule_cfg as (
  select * from public.v8_resolve_sale_schedule_policy()
), kill_cfg as (
  select coalesce((select emergency_stop from public.v8_bot_kill_switch where singleton_key='global'),false) as emergency_stop,
         coalesce((select generation from public.v8_bot_kill_switch where singleton_key='global'),1) as generation,
         (select reason from public.v8_bot_kill_switch where singleton_key='global') as reason
), resolved as (
  select
    case when upper(coalesce(g.value->>'mode','OBSERVE'))='LIVE' then 'PRODUCTION' else upper(coalesce(g.value->>'mode','OBSERVE')) end as global_mode,
    p.mode as page_mode,
    coalesce((g.value->>'aiguka_can_send_text')::boolean,false) as global_text,
    coalesce((g.value->>'aiguka_can_send_image')::boolean,false) as global_image,
    coalesce((g.value->>'aiguka_can_create_sale_task')::boolean,true) as global_task,
    coalesce((sc.value->>'text_enabled')::boolean,false) as support_text,
    coalesce((sc.value->>'slide_enabled')::boolean,false) as support_image,
    sc.reply_delay_minutes as support_reply_delay_minutes,
    s.schedule_allowed,
    s.schedule_mode,
    s.current_window,
    s.blocked_reason as schedule_blocked_reason,
    s.details as schedule_details,
    k.emergency_stop,
    k.generation,
    k.reason as emergency_reason
  from global_cfg g
  cross join page_cfg p
  cross join support_cfg sc
  cross join schedule_cfg s
  cross join kill_cfg k
), final as (
  select *,
    case
      when emergency_stop then 'OFF'
      when not schedule_allowed then 'OFF'
      when page_mode='OFF' or global_mode='OFF' then 'OFF'
      when page_mode='OBSERVE' or global_mode='OBSERVE' then 'OBSERVE'
      when page_mode='SUPPORT' and global_mode='PRODUCTION' then 'SUPPORT'
      when page_mode='TEST' and global_mode='TEST' then 'TEST'
      when page_mode='PRODUCTION' and global_mode='PRODUCTION' then 'PRODUCTION'
      else 'OBSERVE'
    end as resolved_mode
  from resolved
)
select
  resolved_mode,
  page_mode,
  (
    global_text and schedule_allowed and not emergency_stop
    and (
      (resolved_mode in ('TEST','PRODUCTION') and page_mode<>'SUPPORT')
      or (resolved_mode='SUPPORT' and support_text)
    )
  ),
  (
    global_image and schedule_allowed and not emergency_stop
    and (
      resolved_mode in ('TEST','PRODUCTION')
      or (resolved_mode='SUPPORT' and support_image)
    )
  ),
  global_task,
  jsonb_build_object(
    'global_mode',global_mode,
    'page_mode',page_mode,
    'resolved_mode',resolved_mode,
    'support_slide_only',page_mode='SUPPORT' and not support_text,
    'support_delayed_text',page_mode='SUPPORT' and support_text,
    'support_text_enabled',support_text,
    'support_slide_enabled',support_image,
    'support_reply_delay_minutes',support_reply_delay_minutes,
    'global_can_send_text',global_text,
    'global_can_send_image',global_image,
    'global_can_create_sale_task',global_task,
    'schedule_allowed',schedule_allowed,
    'schedule_mode',schedule_mode,
    'schedule_blocked_reason',schedule_blocked_reason,
    'current_schedule_window',current_window,
    'schedule_details',schedule_details,
    'emergency_stop',emergency_stop,
    'emergency_reason',emergency_reason,
    'control_generation',generation,
    'test_requires_recipient_allowlist',true
  )
from final;
$function$;

comment on function public.v8_resolve_runtime_policy(text)
is 'Resolves global/page/schedule controls. SUPPORT permits requested slides and permits text only as a delayed takeover controlled by support_config and support_reply_delay_minutes.';

create or replace function public.v8_v7_slide_request_policy(p_slide_log_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  sl public.v8_slide_logs%rowtype;
  src public.v8_messages_raw%rowtype;
  source_queue public.v8_processing_queue%rowtype;
  v_policy record;
  v_cfg jsonb:='{}'::jsonb;
  v_enabled boolean:=false;
  v_support_slide_only boolean:=false;
  v_intent text;
  v_scope text;
  v_catalog_scope text;
  v_group_scope text;
  v_ai_decision_id uuid;
  v_has_contact boolean:=false;
  v_customer_declined boolean:=false;
  v_newer_scope_conflict boolean:=false;
  v_newer record;
  v_newer_intent text;
  v_newer_scope text;
  v_newer_catalog text;
  v_newer_group text;
  v_newer_group_context jsonb;
  v_newer_text text;
  v_blocked_reason text;
  v_protected boolean:=false;
begin
  select * into sl from public.v8_slide_logs where id=p_slide_log_id;
  if sl.id is null then
    return jsonb_build_object(
      'protected',false,'allow_delivery',false,'blocked_reason','slide_log_not_found',
      'version','v7_slide_request_delivery_v2'
    );
  end if;

  select * into src from public.v8_messages_raw where id=sl.message_id;

  begin
    if nullif(sl.reason->>'queue_id','') is not null then
      select * into source_queue
      from public.v8_processing_queue
      where id=(sl.reason->>'queue_id')::uuid;
    end if;
  exception when invalid_text_representation then
    null;
  end;

  if source_queue.id is null and src.id is not null then
    select * into source_queue
    from public.v8_processing_queue q
    where q.page_id=src.page_id and q.message_id=src.message_id
    order by q.created_at desc
    limit 1;
  end if;

  v_intent:=coalesce(nullif(source_queue.intent_type,''),nullif(sl.reason->>'intent_type',''));
  if v_intent is null and nullif(sl.reason->>'ai_decision_id','') is not null then
    begin
      v_ai_decision_id:=(sl.reason->>'ai_decision_id')::uuid;
      select d.intent_type into v_intent from public.v8_ai_decisions d where d.id=v_ai_decision_id;
    exception when invalid_text_representation then
      v_intent:=null;
    end;
  end if;

  v_catalog_scope:=coalesce(nullif(source_queue.catalog_key,''),nullif(sl.catalog_key,''));
  v_group_scope:=coalesce(
    nullif(source_queue.payload#>>'{mapping_resolution,group_key}',''),
    nullif(source_queue.product_key,''),
    nullif(sl.product_key,'')
  );
  if v_group_scope is null and v_catalog_scope is not null then
    select r.group_key into v_group_scope
    from public.v8_resolve_business_group(v_catalog_scope) r
    limit 1;
  end if;
  v_scope:=coalesce(v_catalog_scope,v_group_scope);

  select value into v_cfg
  from public.v8_config_hub
  where key='v7_slide_request_policy'
    and scope='page:'||sl.page_id
    and is_active
  order by updated_at desc
  limit 1;
  v_enabled:=coalesce((v_cfg->>'enabled')::boolean,false);

  select * into v_policy from public.v8_resolve_runtime_policy(sl.page_id) limit 1;
  v_support_slide_only:=
    coalesce(v_policy.page_mode,'')='SUPPORT'
    and coalesce(v_policy.can_send_image,false)
    and coalesce((v_policy.policy_source->>'support_slide_enabled')::boolean,true);

  v_protected:=v_enabled and v_support_slide_only and v_intent='ask_sample';
  v_has_contact:=public.v8_customer_has_contact(sl.customer_id);

  if v_protected and src.id is not null then
    for v_newer in
      select
        m.id,m.message_text,m.sent_at,
        q.intent_type,q.catalog_key,q.product_key,q.group_key
      from public.v8_messages_raw m
      left join lateral (
        select
          pq.intent_type,pq.catalog_key,pq.product_key,
          nullif(pq.payload#>>'{mapping_resolution,group_key}','') as group_key
        from public.v8_processing_queue pq
        where pq.page_id=m.page_id and pq.message_id=m.message_id
        order by pq.created_at desc
        limit 1
      ) q on true
      where m.customer_id=sl.customer_id
        and m.direction='inbound'
        and m.sent_at>src.sent_at
      order by m.sent_at,m.created_at
    loop
      v_newer_intent:=nullif(v_newer.intent_type,'');
      if v_newer_intent is null then
        select r.intent_type into v_newer_intent
        from public.v8_detect_intent_rule(v_newer.message_text) r
        limit 1;
      end if;

      v_newer_text:=lower(public.unaccent(coalesce(v_newer.message_text,'')));
      if v_newer_intent in ('decline','decline_contact','decline_interest')
         or v_newer_text ~ '(^|[[:space:][:punct:]])(khong can|khong gui|dung gui|khoi gui|thoi khong can)[[:space:]]+(them[[:space:]]+)?(anh|hinh|mau|slide)([[:space:][:punct:]]|$)' then
        v_customer_declined:=true;
      end if;

      v_newer_catalog:=nullif(v_newer.catalog_key,'');
      v_newer_group:=coalesce(nullif(v_newer.group_key,''),nullif(v_newer.product_key,''));
      if v_newer_catalog is null then
        select d.catalog_key into v_newer_catalog
        from public.v8_detect_catalog_smart(v_newer.message_text) d
        limit 1;
      end if;
      if v_newer_group is null and v_newer_catalog is not null then
        select r.group_key into v_newer_group
        from public.v8_resolve_business_group(v_newer_catalog) r
        limit 1;
      end if;
      if v_newer_group is null then
        v_newer_group_context:=public.v8_resolve_group_context(v_newer.message_text);
        if v_newer_group_context->>'status'='resolved' then
          v_newer_group:=nullif(v_newer_group_context#>>'{group,group_key}','');
        end if;
      end if;
      v_newer_scope:=coalesce(v_newer_catalog,v_newer_group);
      if v_newer_intent='ask_sample'
         and (
           (v_catalog_scope is not null and v_newer_catalog is not null
             and v_newer_catalog is distinct from v_catalog_scope)
           or
           (v_group_scope is not null and v_newer_group is not null
             and v_newer_group is distinct from v_group_scope)
         ) then
        v_newer_scope_conflict:=true;
      end if;
    end loop;
  end if;

  v_blocked_reason:=case
    when not v_protected then null
    when v_has_contact then 'customer_contact_provided'
    when v_customer_declined then 'customer_declined_after_sample_request'
    when v_newer_scope_conflict then 'newer_sample_scope_requested'
    else null
  end;

  return jsonb_build_object(
    'protected',v_protected,
    'allow_delivery',v_protected and v_blocked_reason is null,
    'blocked_reason',v_blocked_reason,
    'has_contact',v_has_contact,
    'customer_declined',v_customer_declined,
    'newer_scope_conflict',v_newer_scope_conflict,
    'intent_type',v_intent,
    'source_queue_id',source_queue.id,
    'source_scope',v_scope,
    'support_slide_only',v_support_slide_only,
    'text_reply_owner',coalesce(v_cfg->>'text_reply_owner','aiguka_after_support_delay'),
    'version','v7_slide_request_delivery_v2'
  );
end;
$function$;

comment on function public.v8_v7_slide_request_policy(uuid)
is 'Protects explicit ask_sample slide delivery on SUPPORT Pages even when delayed text takeover is enabled. Contact, explicit decline, or a newer different sample scope still blocks.';

create or replace function public.v8_ai_stage_decision(p_decision_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  d public.v8_ai_decisions%rowtype;
  r public.v8_ai_brain_runtime%rowtype;
  m public.v8_messages_raw%rowtype;
  s public.v8_conversation_states%rowtype;
  v_policy record;
  v_support_config jsonb:='{}'::jsonb;
  v_support_delay_minutes integer:=10;
  v_support_takeover boolean:=false;
  v_available_after timestamptz:=now();
  v_reply_plan_id uuid;
  v_asset_id uuid;
  v_slide_count integer:=0;
  v_blocking_advisories jsonb:='[]'::jsonb;
begin
  select * into d from public.v8_ai_decisions where id=p_decision_id;
  if d.id is null then return jsonb_build_object('ok',false,'reason','decision_not_found'); end if;
  select * into r from public.v8_ai_brain_runtime where page_id=d.page_id;
  if coalesce(r.mode,'OFF')<>'ACTIVE' then return jsonb_build_object('ok',true,'staged',false,'reason','brain_not_active','mode',coalesce(r.mode,'OFF')); end if;
  if d.status<>'completed' then return jsonb_build_object('ok',true,'staged',false,'reason','decision_not_completed'); end if;

  select coalesce(jsonb_agg(e.value),'[]'::jsonb)
    into v_blocking_advisories
  from jsonb_array_elements(coalesce(d.rule_advisories,'[]'::jsonb)) e(value)
  where e.value->>'severity'='block';

  if jsonb_array_length(coalesce(v_blocking_advisories,'[]'::jsonb))>0 then
    return jsonb_build_object(
      'ok',true,'staged',false,
      'reason','AI_REGENERATION_REQUIRED_BY_SAFETY_ADVISORY',
      'advisories',v_blocking_advisories,
      'ai_reply_preserved',true,
      'automation_generated_replacement',false
    );
  end if;

  if not d.should_reply or nullif(btrim(coalesce(d.final_reply,'')),'') is null then return jsonb_build_object('ok',true,'staged',false,'reason','no_reply_requested'); end if;
  if coalesce(d.confidence,0)<coalesce(r.min_confidence_to_reply,.78) then return jsonb_build_object('ok',true,'staged',false,'reason','confidence_below_threshold','confidence',d.confidence); end if;
  select * into m from public.v8_messages_raw where page_id=d.page_id and message_id=d.message_id limit 1;
  if m.id is null or m.direction<>'inbound' then return jsonb_build_object('ok',true,'staged',false,'reason','source_message_missing'); end if;
  select * into s from public.v8_conversation_states where customer_id=d.customer_id;
  if s.manual_pause_until>now() then return jsonb_build_object('ok',true,'staged',false,'reason','human_pause_active','until',s.manual_pause_until); end if;
  if exists(select 1 from public.v8_messages_raw x where x.customer_id=d.customer_id and x.direction='inbound' and x.sent_at>m.sent_at) then return jsonb_build_object('ok',true,'staged',false,'reason','newer_customer_message'); end if;
  if exists(select 1 from public.v8_messages_raw x where x.customer_id=d.customer_id and x.direction='outbound' and x.sent_at>=m.sent_at and public.v8_is_actionable_external_outbound(x.source_system,x.message_text,x.attachments,x.is_automatic,x.actor_type,x.source_detail)) then return jsonb_build_object('ok',true,'staged',false,'reason','external_responder_replied'); end if;

  select * into v_policy from public.v8_resolve_runtime_policy(d.page_id) limit 1;
  select coalesce(support_config,'{}'::jsonb),
         least(greatest(coalesce(support_reply_delay_minutes,10),0),120)
    into v_support_config,v_support_delay_minutes
  from public.bot_working_settings
  where setting_key='default'
  order by updated_at desc
  limit 1;

  v_support_takeover:=
    coalesce(v_policy.runtime_mode,'')='SUPPORT'
    and coalesce((v_support_config->>'text_enabled')::boolean,false);

  if coalesce(v_policy.runtime_mode,'OFF')='SUPPORT' and not v_support_takeover then
    return jsonb_build_object('ok',true,'staged',false,'reason','support_text_disabled');
  end if;

  v_available_after:=case
    when v_support_takeover then m.sent_at+make_interval(mins=>v_support_delay_minutes)
    else now()
  end;

  insert into public.v8_reply_plans(
    customer_id,page_id,sender_id,message_id,business_group_key,intent_type,conversation_stage,action_type,suggested_reply,
    should_request_phone,should_ask_need,should_handoff_sale,safety_status,reason,send_eligible,blocked_reason,
    available_after,runtime_mode,is_latest_customer_turn
  ) values(
    d.customer_id,d.page_id,d.sender_id,d.message_id,d.product_scope,d.intent_type,
    coalesce(nullif(d.decision->>'conversation_stage',''),'ai_decided'),
    coalesce(nullif(d.decision->>'action_type',''),'ai_response'),d.final_reply,
    d.should_request_contact,d.needs_clarification,d.should_handoff_sale,'ready_to_send',
    jsonb_build_object(
      'ai_brain',true,
      'ai_decision_id',d.id,
      'provider_key',d.provider_key,
      'model_name',d.model_name,
      'confidence',d.confidence,
      'evidence_summary',d.evidence_summary,
      'risk_flags',d.risk_flags,
      'rule_advisories',d.rule_advisories,
      'decision_authority',d.decision_authority,
      'support_takeover',v_support_takeover,
      'support_delay_minutes',case when v_support_takeover then v_support_delay_minutes else 0 end,
      'support_available_after',case when v_support_takeover then v_available_after else null end
    ),
    true,null,v_available_after,coalesce(v_policy.runtime_mode,'OBSERVE'),true
  ) returning id into v_reply_plan_id;

  if d.should_send_slide and r.allow_images then
    for v_asset_id in select value::text::uuid from jsonb_array_elements_text(coalesce(d.slide_asset_ids,'[]'::jsonb))
    loop
      insert into public.v8_slide_logs(customer_id,message_id,page_id,sender_id,product_key,catalog_key,folder_path,slide_url,send_status,decision_status,safety_status,reason,asset_id)
      select d.customer_id,m.id,d.page_id,d.sender_id,d.product_scope,d.catalog_key,a.parent_folder_name,
             coalesce(nullif(a.delivery_url,''),a.file_url),'queued','ready','ready_to_send',
             jsonb_build_object('ai_brain',true,'ai_decision_id',d.id,'reply_plan_id',v_reply_plan_id,'confidence',d.confidence),a.id
      from public.v8_drive_assets a
      where a.id=v_asset_id and a.is_active and a.is_image and coalesce(a.delivery_status,'verified')<>'error'
      on conflict(message_id,slide_url) where message_id is not null and slide_url is not null do nothing;
      if found then v_slide_count:=v_slide_count+1; end if;
    end loop;
  end if;
  return jsonb_build_object(
    'ok',true,'staged',true,'reply_plan_id',v_reply_plan_id,'slides_staged',v_slide_count,
    'decision_authority','ai','runtime_mode',coalesce(v_policy.runtime_mode,'OBSERVE'),
    'support_takeover',v_support_takeover,'available_after',v_available_after
  );
end;
$function$;

comment on function public.v8_ai_stage_decision(uuid)
is 'Stages AI decisions. In SUPPORT mode, text is queued for the configured Sale wait time; requested verified slides remain immediate and independently protected.';
