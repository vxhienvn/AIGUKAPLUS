create or replace function public.v8_resolve_messaging_channel(
  p_page_id text,
  p_customer_id uuid,
  p_utility_message_class text default null,
  p_is_promotional boolean default false
)
returns jsonb
language plpgsql
stable security definer
set search_path='public'
as $function$
declare
  v_state_last_customer timestamptz;
  v_raw_last_customer timestamptz;
  v_last_customer timestamptz;
  v_status text:='unknown';
  v_enabled boolean:=false;
  v_within_24h boolean:=false;
  v_class text:=lower(coalesce(nullif(btrim(p_utility_message_class),''),'conversation_sales'));
  v_allowed_class boolean:=false;
  v_notification_token text;
  v_notification_expires_at timestamptz;
begin
  select last_customer_message_at into v_state_last_customer
  from public.v8_conversation_states
  where customer_id=p_customer_id;

  select max(sent_at) into v_raw_last_customer
  from public.v8_messages_raw
  where customer_id=p_customer_id
    and direction='inbound'
    and actor_type='customer';

  v_last_customer:=greatest(
    coalesce(v_state_last_customer,'epoch'::timestamptz),
    coalesce(v_raw_last_customer,'epoch'::timestamptz)
  );
  if v_last_customer='epoch'::timestamptz then v_last_customer:=null; end if;
  v_within_24h:=v_last_customer is not null and v_last_customer>=now()-interval '24 hours';

  select pages_utility_messaging_status,utility_mode_enabled
    into v_status,v_enabled
  from public.v8_page_messaging_capabilities where page_id=p_page_id;

  if v_within_24h then
    return jsonb_build_object(
      'channel','standard_24h','window_status','open','send_allowed_by_window',true,
      'utility_eligible',false,'utility_permission_status',coalesce(v_status,'unknown'),
      'window_anchor_at',v_last_customer,
      'window_anchor_source',case when v_raw_last_customer>=coalesce(v_state_last_customer,'epoch'::timestamptz) then 'messages_raw' else 'conversation_state' end
    );
  end if;

  if coalesce(p_is_promotional,false) then
    select s.notification_messages_token,s.expires_at
      into v_notification_token,v_notification_expires_at
    from public.v8_marketing_message_subscriptions s
    where s.page_id=p_page_id
      and s.customer_id=p_customer_id
      and s.status='active'
      and nullif(btrim(coalesce(s.notification_messages_token,'')),'') is not null
      and (s.expires_at is null or s.expires_at>now())
    order by s.updated_at desc
    limit 1;

    if v_notification_token is not null then
      return jsonb_build_object(
        'channel','notification_messages','window_status','opted_in','send_allowed_by_window',true,
        'utility_eligible',false,'is_promotional',true,
        'notification_messages_token',v_notification_token,
        'token_expires_at',v_notification_expires_at
      );
    end if;
  end if;

  v_allowed_class:=v_class in ('order_update','appointment_update','account_update','service_update','post_purchase_support');
  if coalesce(p_is_promotional,false)=false
     and v_allowed_class
     and coalesce(v_enabled,false)
     and lower(coalesce(v_status,'unknown')) in ('approved','advanced','active') then
    return jsonb_build_object(
      'channel','utility','window_status','outside_24h','send_allowed_by_window',true,
      'utility_eligible',true,'utility_message_class',v_class,
      'utility_permission_status',v_status
    );
  end if;

  return jsonb_build_object(
    'channel','blocked','window_status','outside_24h','send_allowed_by_window',false,
    'utility_eligible',false,'utility_message_class',v_class,
    'utility_permission_status',coalesce(v_status,'unknown'),
    'blocked_reason',case
      when coalesce(p_is_promotional,false) then 'promotional_content_requires_active_optin'
      when not v_allowed_class then 'message_class_not_utility'
      when not coalesce(v_enabled,false) then 'utility_mode_not_enabled'
      else 'utility_permission_not_verified'
    end
  );
end;
$function$;

create or replace function public.v8_stage_showroom_promotion(
  p_customer_id uuid,
  p_source_message_row_id uuid default null,
  p_requested_by text default 'system',
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
  v_cfg jsonb;
  v_campaign_key text;
  v_elements jsonb;
  v_channel jsonb;
  v_policy record;
  v_subscription_id uuid;
  v_delivery_id uuid;
  v_reply_plan_id uuid;
  v_outbound_id uuid;
  v_payload jsonb;
  v_page_allowed boolean:=false;
  v_due_at timestamptz;
begin
  select * into c from public.v8_customers where id=p_customer_id;
  if c.id is null then return jsonb_build_object('ok',false,'reason','customer_not_found'); end if;

  select value into v_cfg
  from public.v8_config_hub
  where scope='promotion' and key='showroom_event_202607_full_carousel' and is_active
  order by updated_at desc limit 1;
  v_cfg:=coalesce(v_cfg,'{}'::jsonb);
  if not coalesce((v_cfg->>'enabled')::boolean,false) then
    return jsonb_build_object('ok',true,'staged',false,'reason','promotion_disabled');
  end if;

  select exists(
    select 1 from jsonb_array_elements_text(coalesce(v_cfg->'page_ids','[]'::jsonb)) p(value)
    where p.value=c.page_id
  ) into v_page_allowed;
  if not v_page_allowed then return jsonb_build_object('ok',true,'staged',false,'reason','page_not_enabled'); end if;

  if c.phone is not null or c.zalo is not null then
    return jsonb_build_object('ok',true,'staged',false,'reason','contact_already_captured');
  end if;

  if p_source_message_row_id is not null then
    select * into m from public.v8_messages_raw where id=p_source_message_row_id and customer_id=c.id;
  end if;
  if m.id is null then
    select * into m
    from public.v8_messages_raw
    where customer_id=c.id and source_system='meta_marketing_optin'
    order by sent_at desc,created_at desc limit 1;
  end if;
  if m.id is null then
    select * into m
    from public.v8_messages_raw
    where customer_id=c.id and direction='inbound' and actor_type='customer'
    order by sent_at desc,created_at desc limit 1;
  end if;
  if m.id is null then return jsonb_build_object('ok',true,'staged',false,'reason','source_message_missing'); end if;

  v_campaign_key:=coalesce(nullif(v_cfg->>'campaign_key',''),'showroom_event_202607_v1');
  v_elements:=coalesce(v_cfg->'elements','[]'::jsonb);
  if jsonb_array_length(v_elements)=0 then
    return jsonb_build_object('ok',false,'reason','promotion_elements_missing');
  end if;

  v_channel:=public.v8_resolve_messaging_channel(c.page_id,c.id,null,true);
  if not coalesce((v_channel->>'send_allowed_by_window')::boolean,false) then
    return jsonb_build_object('ok',true,'staged',false,'reason','messaging_window_blocked','channel',v_channel);
  end if;

  select s.id into v_subscription_id
  from public.v8_marketing_message_subscriptions s
  where s.page_id=c.page_id and s.customer_id=c.id and s.status='active'
  order by s.updated_at desc limit 1;

  if exists(
    select 1 from public.v8_messages_raw x
    where x.customer_id=c.id and x.direction='outbound' and x.sent_at>m.sent_at
      and (
        public.v8_is_actionable_external_outbound(x.source_system,x.message_text,x.attachments,x.is_automatic,x.actor_type,x.source_detail)
        or public.v8_is_unresolved_page_outbound_candidate(x.source_system,x.message_text,x.attachments,x.is_automatic,x.actor_type,x.source_detail)
      )
  ) then
    return jsonb_build_object('ok',true,'staged',false,'reason','human_or_unresolved_page_replied_after_source');
  end if;

  if exists(select 1 from public.v8_promotion_delivery_log d where d.customer_id=c.id and d.campaign_key=v_campaign_key) then
    return jsonb_build_object('ok',true,'staged',false,'reason','promotion_already_staged_or_sent','campaign_key',v_campaign_key);
  end if;

  if p_dry_run then
    return jsonb_build_object(
      'ok',true,'dry_run',true,'staged',false,'campaign_key',v_campaign_key,
      'page_id',c.page_id,'sender_id',c.sender_id,'channel',v_channel,
      'element_count',jsonb_array_length(v_elements),'elements',v_elements
    );
  end if;

  insert into public.v8_promotion_delivery_log(
    campaign_key,subscription_id,customer_id,page_id,sender_id,source_message_row_id,status,requested_by,details
  ) values(
    v_campaign_key,v_subscription_id,c.id,c.page_id,c.sender_id,m.id,'preparing',p_requested_by,
    jsonb_build_object('channel',v_channel->>'channel','source_message_id',m.message_id)
  )
  on conflict(customer_id,campaign_key) do nothing
  returning id into v_delivery_id;
  if v_delivery_id is null then
    return jsonb_build_object('ok',true,'staged',false,'reason','promotion_deduped_concurrently');
  end if;

  select * into v_policy from public.v8_resolve_runtime_policy(c.page_id) limit 1;
  v_due_at:=greatest(now()+interval '20 seconds',m.sent_at+interval '20 seconds');

  insert into public.v8_reply_plans(
    customer_id,page_id,sender_id,message_id,pipeline_version,
    business_group_key,intent_type,conversation_stage,action_type,suggested_reply,
    should_request_phone,should_ask_need,should_handoff_sale,safety_status,reason,
    send_eligible,blocked_reason,available_after,runtime_mode,is_latest_customer_turn,
    messaging_channel,utility_eligible,dispatch_status,dispatched_at
  ) values(
    c.id,c.page_id,c.sender_id,m.message_id,'promotion_v1',
    'showroom_promotion','promotion_optin','promotion_opted_in','promotion_carousel',
    'Chương trình ưu đãi showroom tháng 7–8/2026',
    false,false,false,'ready_to_send',jsonb_build_object(
      'is_promotional',true,'campaign_key',v_campaign_key,'promotion_delivery_id',v_delivery_id,
      'requested_by',p_requested_by,'source_system',m.source_system,'channel',v_channel->>'channel'
    ),true,null,v_due_at,coalesce(v_policy.runtime_mode,'OBSERVE'),true,
    v_channel->>'channel',false,'staged',now()
  ) returning id into v_reply_plan_id;

  v_payload:=jsonb_build_object(
    'campaign_key',v_campaign_key,
    'promotion_delivery_id',v_delivery_id,
    'delivery_mode',v_channel->>'channel',
    'is_promotional',true,
    'elements',v_elements,
    'zalo_url',v_cfg->>'zalo_url',
    'zalo_number',v_cfg->>'zalo_number',
    'source_message_id',m.message_id,
    'pipeline_version','promotion_v1'
  );
  if v_channel->>'channel'='notification_messages' then
    v_payload:=v_payload||jsonb_build_object('notification_messages_token',v_channel->>'notification_messages_token');
  end if;

  insert into public.v8_outbound_queue(
    customer_id,page_id,sender_id,reply_plan_id,pipeline_version,message_type,payload,
    messaging_channel,status,due_at
  ) values(
    c.id,c.page_id,c.sender_id,v_reply_plan_id,'promotion_v1','generic_template',v_payload,
    v_channel->>'channel','ready',v_due_at
  ) returning id into v_outbound_id;

  update public.v8_promotion_delivery_log
  set reply_plan_id=v_reply_plan_id,outbound_id=v_outbound_id,status='queued',
      details=details||jsonb_build_object('element_count',jsonb_array_length(v_elements),'outbound_id',v_outbound_id),
      updated_at=now()
  where id=v_delivery_id;

  return jsonb_build_object(
    'ok',true,'staged',true,'campaign_key',v_campaign_key,'channel',v_channel->>'channel',
    'element_count',jsonb_array_length(v_elements),'reply_plan_id',v_reply_plan_id,
    'outbound_id',v_outbound_id,'promotion_delivery_id',v_delivery_id,'due_at',v_due_at
  );
end;
$function$;

revoke all on function public.v8_stage_showroom_promotion(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.v8_stage_showroom_promotion(uuid,uuid,text,boolean) to service_role;
