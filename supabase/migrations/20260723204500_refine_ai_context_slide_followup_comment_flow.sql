-- AI context: only four latest customer messages, one relevant rule/guide/lesson.
update public.v8_ai_brain_runtime
set max_history_messages=4,
    max_tool_rounds=1,
    settings=coalesce(settings,'{}'::jsonb)||jsonb_build_object(
      'customer_history_only',true,
      'max_customer_history_messages',4,
      'salutation_source','profile_only_no_ai_inference',
      'slide_selection_mode','ai_catalog_only_system_assets',
      'max_relevant_contexts',1,
      'max_prompt_branches',1,
      'max_learning_cases',1,
      'prompt_version','evidence_first_single_call_v2'
    ),
    updated_at=now();

update public.v8_config_hub
set value=coalesce(value,'{}'::jsonb)||jsonb_build_object(
  'version','evidence_first_single_call_v2',
  'max_history_messages',4,
  'customer_history_only',true,
  'max_relevant_contexts',1,
  'max_prompt_branches',1,
  'max_learning_cases',1,
  'max_catalog_candidates',8,
  'salutation_source','profile_only_no_ai_inference',
  'slide_selection_mode','ai_catalog_only_system_assets',
  'updated_at',now()
),updated_at=now()
where scope='runtime' and key='ai_quota_optimization' and is_active;

-- Comments are deterministic, zero-token. AI starts only when the customer continues in Messenger.
update public.v8_config_hub
set value=coalesce(value,'{}'::jsonb)||jsonb_build_object(
  'decision_mode','deterministic_private_reply_then_inbox_ai',
  'ai_on_comment',false,
  'neutral_salutation',true,
  'mapping_required',true,
  'version','comment_zero_token_v2'
),updated_at=now()
where scope='conversation' and key='comment_messenger_policy' and is_active;

create or replace function public.v8_stage_comment_private_reply(
  p_comment_event_id uuid,
  p_dry_run boolean default true,
  p_requested_by text default 'comment_webhook'
)
returns jsonb
language plpgsql
security definer
set search_path='public'
as $function$
declare
  ce public.v8_comment_events%rowtype;
  v_cfg jsonb:='{}'::jsonb;
  v_policy record;
  v_group_name text:='sản phẩm';
  v_text text;
  v_price jsonb;
  v_min_score integer:=20;
  v_max_age integer:=7;
  v_auto boolean:=true;
  v_outbound_id uuid;
begin
  select * into ce from public.v8_comment_events where id=p_comment_event_id for update;
  if ce.id is null then return jsonb_build_object('ok',false,'staged',false,'reason','COMMENT_EVENT_NOT_FOUND'); end if;

  select value into v_cfg
  from public.v8_config_hub
  where key='comment_messenger_policy' and scope='conversation' and is_active
  order by updated_at desc limit 1;

  v_min_score:=greatest(coalesce((v_cfg->>'minimum_lead_score')::integer,20),0);
  v_max_age:=least(greatest(coalesce((v_cfg->>'max_comment_age_days')::integer,7),1),7);
  v_auto:=coalesce((v_cfg->>'auto_send_enabled')::boolean,true);

  if not coalesce((v_cfg->>'enabled')::boolean,true) then return jsonb_build_object('ok',true,'staged',false,'reason','COMMENT_MESSENGER_DISABLED'); end if;
  if ce.has_contact or ce.detected_phone is not null then return jsonb_build_object('ok',true,'staged',false,'reason','CONTACT_ALREADY_PROVIDED'); end if;
  if ce.lead_status<>'qualified' or ce.lead_score<v_min_score then return jsonb_build_object('ok',true,'staged',false,'reason','COMMENT_NOT_QUALIFIED','lead_status',ce.lead_status,'lead_score',ce.lead_score); end if;
  if ce.event_time<now()-make_interval(days=>v_max_age) then return jsonb_build_object('ok',true,'staged',false,'reason','COMMENT_PRIVATE_REPLY_WINDOW_EXPIRED'); end if;
  if ce.private_reply_status in ('queued','sending','sent','responded') then return jsonb_build_object('ok',true,'staged',false,'reason','COMMENT_ALREADY_PLANNED','status',ce.private_reply_status); end if;
  if not p_dry_run and not v_auto then return jsonb_build_object('ok',true,'staged',false,'reason','COMMENT_AUTO_SEND_DISABLED'); end if;

  select * into v_policy from public.v8_resolve_runtime_policy(ce.page_id) limit 1;
  if not coalesce(v_policy.can_send_text,false) then return jsonb_build_object('ok',true,'staged',false,'reason','PAGE_TEXT_RUNTIME_BLOCKED','runtime_mode',v_policy.runtime_mode); end if;

  select group_name into v_group_name
  from public.v8_business_product_groups
  where group_key=ce.product_key limit 1;
  v_group_name:=coalesce(nullif(v_group_name,''),'sản phẩm đang xem');

  v_text:=case
    when ce.intent_type='ask_address' then
      'Dạ showroom tại 254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội. Mình cần gửi định vị hoặc hướng dẫn đường đi không ạ?'
    when ce.intent_type='ask_sample' then
      'Dạ, mình đang quan tâm '||v_group_name||'. Mình gửi giúp ảnh hoặc tên mẫu đang xem, bên em gửi đúng catalog ngay ạ.'
    when ce.intent_type='ask_price' then
      'Dạ, '||v_group_name||' có nhiều mức giá theo mẫu và cấu hình. Mình gửi giúp ảnh hoặc mã đang xem, bên em kiểm tra đúng mẫu và báo giá cụ thể ạ.'
    else
      'Dạ, mình cần xem mẫu, báo giá hay thông số của '||v_group_name||' ạ? Bên em hỗ trợ ngay.'
  end;

  v_price:=public.v8_validate_reply_price_safety(
    v_text,'comment_private_reply',ce.intent_type,ce.product_key,
    jsonb_build_object('source','comment_zero_token_v2')
  );
  if not coalesce((v_price->>'allowed')::boolean,false) then
    return jsonb_build_object('ok',true,'staged',false,'reason',v_price->>'reason','price_safety',v_price);
  end if;

  if p_dry_run then
    return jsonb_build_object(
      'ok',true,'staged',false,'dry_run',true,'reason','ELIGIBLE',
      'comment_event_id',ce.id,'page_id',ce.page_id,'comment_id',ce.comment_id,
      'text',v_text,'runtime_mode',v_policy.runtime_mode,'ai_tokens',0
    );
  end if;

  insert into public.v8_outbound_queue(
    customer_id,page_id,sender_id,reply_plan_id,slide_log_id,comment_event_id,
    message_type,payload,messaging_channel,utility_message_class,status,due_at
  ) values(
    ce.customer_id,ce.page_id,coalesce(ce.sender_id,ce.comment_id),null,null,ce.id,
    'text',jsonb_build_object(
      'text',v_text,'delivery_mode','comment_private_reply','comment_id',ce.comment_id,
      'post_id',ce.post_id,'ad_id',ce.ad_id,'source_comment_event_id',ce.id,
      'price_safety',v_price,'requested_by',p_requested_by,
      'decision_mode','deterministic_zero_token'
    ),'private_reply','comment_private_reply','ready',now()
  )
  on conflict(comment_event_id) where comment_event_id is not null do update set
    payload=excluded.payload,due_at=excluded.due_at,
    status=case when public.v8_outbound_queue.status in ('sent','cancelled') then public.v8_outbound_queue.status else 'ready' end,
    updated_at=now()
  returning id into v_outbound_id;

  update public.v8_comment_events
  set private_reply_status='queued',private_reply_text=v_text,
      classifier_reason=coalesce(classifier_reason,'{}'::jsonb)||jsonb_build_object(
        'decision_mode','deterministic_zero_token','ai_tokens',0,'template_version','comment_zero_token_v2'
      ),
      updated_at=now()
  where id=ce.id;

  return jsonb_build_object(
    'ok',true,'staged',true,'comment_event_id',ce.id,'outbound_id',v_outbound_id,
    'text',v_text,'runtime_mode',v_policy.runtime_mode,'ai_tokens',0
  );
end;
$function$;

-- One single promotional follow-up message, no AI, once per campaign.
insert into public.v8_config_hub(scope,key,value,is_active,updated_at)
values(
  'promotion','showroom_event_202607_single_followup_text',
  jsonb_build_object(
    'enabled',true,
    'campaign_key','showroom_event_202607_v1',
    'page_ids',jsonb_build_array('104810069068200','985632314640803'),
    'day_wait_hours',4,
    'night_wait_hours',2,
    'day_start_hour',8,
    'night_start_hour',18,
    'max_age_hours',20,
    'scan_interval_minutes',15,
    'max_per_run',20,
    'one_delivery_per_customer',true,
    'use_ai',false,
    'message_text','Showroom Ánh Dương gửi mình toàn bộ ưu đãi tháng 7–8: miễn phí vận chuyển tại Hà Nội, Thái Nguyên, Hải Phòng, Hưng Yên, Hà Nam, Hải Dương, Hòa Bình và trong bán kính 80 km; hỗ trợ đi lại tới 300.000đ khi qua xem và đặt hàng/đặt cọc; đơn từ 30 triệu có quà tặng tùy đơn gồm máy hút mùi, bếp từ hoặc quạt trần vàng gương 8–10 cánh. Showroom: 254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội. Hotline 0973 693 677 • Zalo 0989882690.'
  ),true,now()
)
on conflict(scope,key) do update
set value=excluded.value,is_active=true,updated_at=excluded.updated_at;

update public.v8_config_hub
set value=coalesce(value,'{}'::jsonb)||jsonb_build_object(
  'enabled',false,
  'scheduler_enabled',false,
  'auto_send_enabled',false,
  'decision_authority','deterministic_zero_token_db_cron',
  'daytime_general_hours',4,
  'daytime_hot_hours',4,
  'evening_general_hours',2,
  'evening_hot_hours',2,
  'scan_interval_minutes',15,
  'single_follow_up_per_campaign',true,
  'single_message_all_benefits',true,
  'allow_slide_follow_up',false,
  'use_ai',false,
  'policy_version','single_promotion_followup_zero_token_v1',
  'replacement_job','aiguka_v8_single_followup_promotion',
  'legacy_scheduler_disabled_at',now(),
  'legacy_scheduler_disabled_reason','railway_follow_up_scheduler_replaced_by_zero_token_db_cron'
),updated_at=now()
where scope='conversation' and key='follow_up_policy' and is_active;

update public.v8_ai_brain_requests
set status='skipped',completed_at=now(),dispatch_locked_at=null,dispatch_locked_by=null,
    last_error='legacy_follow_up_scheduler_disabled_zero_token_replacement',
    dispatch_details=coalesce(dispatch_details,'{}'::jsonb)||jsonb_build_object(
      'quota_saved',true,'replacement_job','aiguka_v8_single_followup_promotion','disabled_at',now()
    )
where decision_id is null and status in ('pending','processing','error') and requested_by='follow_up_scan';

create or replace function public.v8_stage_showroom_promotion_single_text(
  p_customer_id uuid,
  p_source_message_row_id uuid default null,
  p_requested_by text default 'single_followup_scan',
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path='public'
as $function$
declare
  c public.v8_customers%rowtype;
  m public.v8_messages_raw%rowtype;
  v_cfg jsonb:='{}'::jsonb;
  v_campaign_key text;
  v_text text;
  v_channel jsonb;
  v_policy record;
  v_delivery_id uuid;
  v_reply_plan_id uuid;
  v_outbound_id uuid;
  v_due_at timestamptz;
  v_last_reply_at timestamptz;
  v_last_reply_source text;
  v_wait_hours integer:=0;
begin
  select * into c from public.v8_customers where id=p_customer_id;
  if c.id is null then return jsonb_build_object('ok',false,'reason','customer_not_found'); end if;

  select value into v_cfg
  from public.v8_config_hub
  where scope='promotion' and key='showroom_event_202607_single_followup_text' and is_active
  order by updated_at desc limit 1;
  v_cfg:=coalesce(v_cfg,'{}'::jsonb);
  if not coalesce((v_cfg->>'enabled')::boolean,false) then
    return jsonb_build_object('ok',true,'staged',false,'reason','single_followup_disabled');
  end if;

  if not exists(
    select 1 from jsonb_array_elements_text(coalesce(v_cfg->'page_ids','[]'::jsonb)) p(value)
    where p.value=c.page_id
  ) then return jsonb_build_object('ok',true,'staged',false,'reason','page_not_enabled'); end if;

  if c.phone is not null or c.zalo is not null or public.v8_customer_has_contact(c.id) then
    return jsonb_build_object('ok',true,'staged',false,'reason','contact_already_captured');
  end if;

  if exists(
    select 1 from public.v8_marketing_message_subscriptions s
    where s.customer_id=c.id and s.page_id=c.page_id and s.status='stopped'
  ) then return jsonb_build_object('ok',true,'staged',false,'reason','promotion_opted_out'); end if;

  if exists(
    select 1 from public.v8_messages_raw x
    where x.customer_id=c.id and x.direction='inbound'
      and public.v8_is_promotion_opt_out_text(x.message_text)
  ) then return jsonb_build_object('ok',true,'staged',false,'reason','promotion_opt_out_text_found'); end if;

  if p_source_message_row_id is not null then
    select * into m
    from public.v8_messages_raw
    where id=p_source_message_row_id and customer_id=c.id and direction='inbound' and actor_type='customer';
  end if;
  if m.id is null then
    select * into m
    from public.v8_messages_raw
    where customer_id=c.id and direction='inbound' and actor_type='customer'
    order by sent_at desc,created_at desc limit 1;
  end if;
  if m.id is null then return jsonb_build_object('ok',true,'staged',false,'reason','source_message_missing'); end if;

  if exists(
    select 1 from public.v8_messages_raw x
    where x.customer_id=c.id and x.direction='inbound' and x.actor_type='customer' and x.sent_at>m.sent_at
  ) then return jsonb_build_object('ok',true,'staged',false,'reason','newer_customer_message'); end if;

  select x.sent_at,x.source_system into v_last_reply_at,v_last_reply_source
  from public.v8_messages_raw x
  where x.customer_id=c.id and x.direction='outbound' and x.sent_at>m.sent_at
    and (
      public.v8_is_actionable_external_outbound(x.source_system,x.message_text,x.attachments,x.is_automatic,x.actor_type,x.source_detail)
      or public.v8_is_unresolved_page_outbound_candidate(x.source_system,x.message_text,x.attachments,x.is_automatic,x.actor_type,x.source_detail)
      or x.source_system in ('aiguka','aiguka_v8')
    )
  order by x.sent_at desc limit 1;
  if v_last_reply_at is null then
    return jsonb_build_object('ok',true,'staged',false,'reason','customer_question_not_answered');
  end if;

  v_campaign_key:=coalesce(nullif(v_cfg->>'campaign_key',''),'showroom_event_202607_v1');
  v_text:=nullif(btrim(coalesce(v_cfg->>'message_text','')),'');
  if v_text is null then return jsonb_build_object('ok',false,'reason','single_followup_text_missing'); end if;

  if exists(
    select 1 from public.v8_promotion_delivery_log d
    where d.customer_id=c.id and d.campaign_key=v_campaign_key
  ) then return jsonb_build_object('ok',true,'staged',false,'reason','promotion_already_staged_or_sent','campaign_key',v_campaign_key); end if;

  v_channel:=public.v8_resolve_messaging_channel(c.page_id,c.id,null,true);
  if v_channel->>'channel'<>'standard_24h' or not coalesce((v_channel->>'send_allowed_by_window')::boolean,false) then
    return jsonb_build_object('ok',true,'staged',false,'reason','standard_window_unavailable','channel',v_channel);
  end if;

  v_wait_hours:=case
    when extract(hour from now() at time zone 'Asia/Bangkok')>=coalesce((v_cfg->>'day_start_hour')::integer,8)
     and extract(hour from now() at time zone 'Asia/Bangkok')<coalesce((v_cfg->>'night_start_hour')::integer,18)
    then coalesce((v_cfg->>'day_wait_hours')::integer,4)
    else coalesce((v_cfg->>'night_wait_hours')::integer,2)
  end;

  if v_last_reply_at>now()-make_interval(hours=>v_wait_hours) then
    return jsonb_build_object('ok',true,'staged',false,'reason','followup_wait_not_reached','wait_hours',v_wait_hours,'last_reply_at',v_last_reply_at);
  end if;

  if p_dry_run then
    return jsonb_build_object(
      'ok',true,'dry_run',true,'staged',false,'campaign_key',v_campaign_key,
      'page_id',c.page_id,'sender_id',c.sender_id,'channel',v_channel,
      'text',v_text,'wait_hours',v_wait_hours,'last_reply_at',v_last_reply_at,
      'ai_tokens',0
    );
  end if;

  insert into public.v8_promotion_delivery_log(
    campaign_key,customer_id,page_id,sender_id,source_message_row_id,status,requested_by,details
  ) values(
    v_campaign_key,c.id,c.page_id,c.sender_id,m.id,'preparing',p_requested_by,
    jsonb_build_object(
      'channel','standard_24h','source_message_id',m.message_id,
      'single_message',true,'ai_tokens',0,'last_reply_at',v_last_reply_at,
      'last_reply_source',v_last_reply_source,'wait_hours',v_wait_hours
    )
  )
  on conflict(customer_id,campaign_key) do nothing
  returning id into v_delivery_id;
  if v_delivery_id is null then
    return jsonb_build_object('ok',true,'staged',false,'reason','promotion_deduped_concurrently');
  end if;

  select * into v_policy from public.v8_resolve_runtime_policy(c.page_id) limit 1;
  v_due_at:=now()+interval '20 seconds';

  insert into public.v8_reply_plans(
    customer_id,page_id,sender_id,message_id,pipeline_version,
    business_group_key,intent_type,conversation_stage,action_type,suggested_reply,
    should_request_phone,should_ask_need,should_handoff_sale,safety_status,reason,
    send_eligible,blocked_reason,available_after,runtime_mode,is_latest_customer_turn,
    messaging_channel,utility_eligible,dispatch_status,dispatched_at
  ) values(
    c.id,c.page_id,c.sender_id,m.message_id,'promotion_v1',
    'showroom_promotion','promotion_follow_up','silent_after_answer','promotion_carousel',v_text,
    false,false,false,'ready_to_send',jsonb_build_object(
      'is_promotional',true,'campaign_key',v_campaign_key,'promotion_delivery_id',v_delivery_id,
      'requested_by','admin_approved_20h_promotion_scan','scan_requested_by',p_requested_by,
      'source_system',m.source_system,'channel','standard_24h',
      'care_case','sale_silence_8h','care_anchor_at',v_last_reply_at,
      'single_message',true,'all_benefits_in_one_message',true,'ai_tokens',0,
      'wait_hours',v_wait_hours,'last_reply_source',v_last_reply_source
    ),true,null,v_due_at,coalesce(v_policy.runtime_mode,'OBSERVE'),true,
    'standard_24h',false,'staged',now()
  ) returning id into v_reply_plan_id;

  insert into public.v8_outbound_queue(
    customer_id,page_id,sender_id,reply_plan_id,pipeline_version,message_type,payload,
    messaging_channel,status,due_at
  ) values(
    c.id,c.page_id,c.sender_id,v_reply_plan_id,'promotion_v1','text',jsonb_build_object(
      'text',v_text,'campaign_key',v_campaign_key,'promotion_delivery_id',v_delivery_id,
      'delivery_mode','standard_24h','is_promotional',true,'single_message',true,
      'all_benefits_in_one_message',true,'source_message_id',m.message_id,
      'care_anchor_at',v_last_reply_at,'ai_tokens',0,'pipeline_version','promotion_v1'
    ),'standard_24h','ready',v_due_at
  ) returning id into v_outbound_id;

  update public.v8_promotion_delivery_log
  set reply_plan_id=v_reply_plan_id,outbound_id=v_outbound_id,status='queued',
      details=details||jsonb_build_object('outbound_id',v_outbound_id,'reply_plan_id',v_reply_plan_id),
      updated_at=now()
  where id=v_delivery_id;

  return jsonb_build_object(
    'ok',true,'staged',true,'campaign_key',v_campaign_key,'channel','standard_24h',
    'reply_plan_id',v_reply_plan_id,'outbound_id',v_outbound_id,
    'promotion_delivery_id',v_delivery_id,'due_at',v_due_at,
    'single_message',true,'ai_tokens',0,'wait_hours',v_wait_hours
  );
end;
$function$;

create or replace function public.v8_scan_showroom_followup_single_text(
  p_limit integer default 20,
  p_dry_run boolean default false,
  p_requested_by text default 'cron_single_followup'
)
returns jsonb
language plpgsql
security definer
set search_path='public'
as $function$
declare
  v_cfg jsonb:='{}'::jsonb;
  v_campaign_key text;
  v_wait_hours integer;
  v_run_id uuid;
  v_candidate_count integer:=0;
  v_staged integer:=0;
  v_skipped integer:=0;
  v_failed integer:=0;
  v_result jsonb;
  v_details jsonb:='[]'::jsonb;
  rec record;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('v8_scan_showroom_followup_single_text',0)) then
    return jsonb_build_object('ok',true,'locked',true,'reason','scan_already_running');
  end if;

  select value into v_cfg
  from public.v8_config_hub
  where scope='promotion' and key='showroom_event_202607_single_followup_text' and is_active
  order by updated_at desc limit 1;
  v_cfg:=coalesce(v_cfg,'{}'::jsonb);
  if not coalesce((v_cfg->>'enabled')::boolean,false) then
    return jsonb_build_object('ok',true,'staged',0,'reason','single_followup_disabled');
  end if;

  v_campaign_key:=coalesce(nullif(v_cfg->>'campaign_key',''),'showroom_event_202607_v1');
  v_wait_hours:=case
    when extract(hour from now() at time zone 'Asia/Bangkok')>=coalesce((v_cfg->>'day_start_hour')::integer,8)
     and extract(hour from now() at time zone 'Asia/Bangkok')<coalesce((v_cfg->>'night_start_hour')::integer,18)
    then coalesce((v_cfg->>'day_wait_hours')::integer,4)
    else coalesce((v_cfg->>'night_wait_hours')::integer,2)
  end;

  insert into public.v8_promotion_scan_runs(campaign_key,requested_by,dry_run,started_at,details)
  values(v_campaign_key,p_requested_by,p_dry_run,now(),jsonb_build_object(
    'mode','single_text_zero_token','wait_hours',v_wait_hours,'scan_interval_minutes',15
  )) returning id into v_run_id;

  for rec in
    with candidates as (
      select c.id as customer_id,li.id as source_message_row_id,li.sent_at as inbound_at,
             lr.sent_at as last_reply_at,lr.source_system as last_reply_source
      from public.v8_customers c
      join lateral (
        select m.id,m.sent_at,m.message_text
        from public.v8_messages_raw m
        where m.customer_id=c.id and m.direction='inbound' and m.actor_type='customer'
        order by m.sent_at desc,m.created_at desc limit 1
      ) li on true
      join lateral (
        select m.sent_at,m.source_system
        from public.v8_messages_raw m
        where m.customer_id=c.id and m.direction='outbound' and m.sent_at>li.sent_at
          and (
            public.v8_is_actionable_external_outbound(m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail)
            or public.v8_is_unresolved_page_outbound_candidate(m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail)
            or m.source_system in ('aiguka','aiguka_v8')
          )
        order by m.sent_at desc limit 1
      ) lr on true
      where exists(
        select 1 from jsonb_array_elements_text(coalesce(v_cfg->'page_ids','[]'::jsonb)) p(value)
        where p.value=c.page_id
      )
        and c.phone is null and c.zalo is null
        and not public.v8_customer_has_contact(c.id)
        and lr.sent_at<=now()-make_interval(hours=>v_wait_hours)
        and li.sent_at>=now()-make_interval(hours=>coalesce((v_cfg->>'max_age_hours')::integer,20))
        and not public.v8_is_promotion_opt_out_text(li.message_text)
        and not exists(
          select 1 from public.v8_promotion_delivery_log d
          where d.customer_id=c.id and d.campaign_key=v_campaign_key
        )
        and not exists(
          select 1 from public.v8_marketing_message_subscriptions s
          where s.customer_id=c.id and s.page_id=c.page_id and s.status='stopped'
        )
        and not exists(
          select 1 from public.v8_ai_brain_requests r
          where r.page_id=c.page_id and r.sender_id=c.sender_id
            and r.status in ('pending','processing') and r.decision_id is null
        )
        and not exists(
          select 1 from public.v8_outbound_queue q
          where q.customer_id=c.id and q.status in ('planned','ready','sending')
        )
      order by lr.sent_at asc
      limit least(greatest(coalesce(p_limit,20),1),100)
    )
    select * from candidates
  loop
    v_candidate_count:=v_candidate_count+1;
    begin
      v_result:=public.v8_stage_showroom_promotion_single_text(
        rec.customer_id,rec.source_message_row_id,p_requested_by,p_dry_run
      );
      if coalesce((v_result->>'staged')::boolean,false) or p_dry_run then
        v_staged:=v_staged+1;
      else
        v_skipped:=v_skipped+1;
      end if;
      v_details:=v_details||jsonb_build_array(jsonb_build_object(
        'customer_id',rec.customer_id,'inbound_at',rec.inbound_at,
        'last_reply_at',rec.last_reply_at,'result',v_result
      ));
    exception when others then
      v_failed:=v_failed+1;
      v_details:=v_details||jsonb_build_array(jsonb_build_object(
        'customer_id',rec.customer_id,'error',sqlerrm
      ));
    end;
  end loop;

  update public.v8_promotion_scan_runs
  set completed_at=now(),candidate_count=v_candidate_count,staged_count=v_staged,
      skipped_count=v_skipped,failed_count=v_failed,
      details=coalesce(details,'{}'::jsonb)||jsonb_build_object('candidates',v_details)
  where id=v_run_id;

  return jsonb_build_object(
    'ok',true,'run_id',v_run_id,'campaign_key',v_campaign_key,
    'wait_hours',v_wait_hours,'candidate_count',v_candidate_count,
    'staged_count',v_staged,'skipped_count',v_skipped,'failed_count',v_failed,
    'dry_run',p_dry_run,'ai_tokens',0
  );
end;
$function$;

do $block$
begin
  if exists(select 1 from cron.job where jobname='aiguka_v8_single_followup_promotion') then
    perform cron.unschedule('aiguka_v8_single_followup_promotion');
  end if;
  perform cron.schedule(
    'aiguka_v8_single_followup_promotion',
    '*/15 * * * *',
    $$select public.v8_scan_showroom_followup_single_text(20,false,'cron_single_followup');$$
  );
end;
$block$;
