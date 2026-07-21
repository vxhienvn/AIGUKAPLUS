create or replace function public.v8_prepare_follow_up_ai_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r public.v8_ai_brain_requests%rowtype;
  c public.v8_customers%rowtype;
  s public.v8_conversation_states%rowtype;
  m public.v8_messages_raw%rowtype;
  rt public.v8_ai_brain_runtime%rowtype;
  pr public.v8_ai_providers%rowtype;
  pol record;
  v_details jsonb:='{}'::jsonb;
  v_anchor timestamptz;
  v_history jsonb:='[]'::jsonb;
  v_memory jsonb:='{}'::jsonb;
  v_reason text;
begin
  select * into r from public.v8_ai_brain_requests where id=p_request_id for update;
  if r.id is null or r.requested_by<>'follow_up_scan' then
    return jsonb_build_object('ok',false,'error','invalid_follow_up_request');
  end if;
  if r.status not in ('pending','error','processing') then
    return jsonb_build_object('ok',true,'skipped',true,'reason','request_not_pending','status',r.status);
  end if;

  v_details:=coalesce(r.dispatch_details,'{}'::jsonb);
  select * into c from public.v8_customers where page_id=r.page_id and sender_id=r.sender_id limit 1;
  select * into m from public.v8_messages_raw
    where page_id=r.page_id and message_id=v_details->>'last_inbound_message_id' limit 1;
  if c.id is null or m.id is null or m.direction<>'inbound' or m.actor_type<>'customer' then
    v_reason:='follow_up_source_missing';
  else
    select * into s from public.v8_conversation_states where customer_id=c.id;
    select * into pol from public.v8_resolve_runtime_policy(r.page_id) limit 1;
    v_anchor:=nullif(v_details->>'care_anchor_at','')::timestamptz;
    if not coalesce(pol.can_send_text,false) then v_reason:='send_text_not_enabled';
    elsif c.phone is not null or c.zalo is not null or coalesce(s.has_phone,false) then v_reason:='customer_has_contact';
    elsif s.manual_pause_until>now() then v_reason:='human_pause_active';
    elsif m.sent_at<now()-interval '23 hours 45 minutes' then v_reason:='messaging_window_too_close_or_closed';
    elsif exists(select 1 from public.v8_messages_raw x where x.customer_id=c.id and x.direction='inbound' and x.sent_at>m.sent_at) then v_reason:='newer_customer_message';
    elsif exists(select 1 from public.v8_messages_raw x where x.customer_id=c.id and x.direction='outbound' and x.sent_at>coalesce(v_anchor,m.sent_at)) then v_reason:='newer_outbound_after_care_anchor';
    elsif exists(select 1 from public.v8_outbound_queue x where x.customer_id=c.id and x.status in ('planned','ready','sending')) then v_reason:='active_outbound_exists';
    end if;
  end if;

  if v_reason is not null then
    update public.v8_ai_brain_requests
    set status='skipped',completed_at=now(),last_error=v_reason,
        dispatch_details=v_details||jsonb_build_object('follow_up_skipped_reason',v_reason,'follow_up_skipped_at',now())
    where id=r.id;
    return jsonb_build_object('ok',true,'skipped',true,'reason',v_reason);
  end if;

  select * into rt from public.v8_ai_brain_runtime where page_id=r.page_id;
  if rt.id is null or rt.mode='OFF' then
    update public.v8_ai_brain_requests set status='skipped',completed_at=now(),last_error='brain_off' where id=r.id;
    return jsonb_build_object('ok',true,'skipped',true,'reason','brain_off');
  end if;
  select * into pr from public.v8_ai_providers where provider_key=coalesce(rt.provider_key,'openai');
  if pr.id is null or not coalesce(pr.is_enabled,false) then
    return jsonb_build_object('ok',false,'error','ai_provider_disabled');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'message_id',x.message_id,'direction',x.direction,'actor_type',x.actor_type,
      'actor_name',x.actor_name,'source_system',x.source_system,'is_automatic',x.is_automatic,
      'text',x.message_text,'has_attachments',coalesce(jsonb_array_length(coalesce(x.attachments,'[]'::jsonb)),0)>0,
      'sent_at',x.sent_at
    ) order by x.sent_at),'[]'::jsonb)
  into v_history
  from (
    select * from public.v8_messages_raw
    where page_id=r.page_id and sender_id=r.sender_id
    order by sent_at desc,created_at desc limit 24
  ) x;

  select coalesce(memory,'{}'::jsonb) into v_memory
  from public.v8_conversation_memory_ai where customer_id=c.id;

  update public.v8_ai_brain_requests
  set status='processing',started_at=coalesce(started_at,now()),attempts=coalesce(attempts,0)+1,last_error=null
  where id=r.id;

  return jsonb_build_object(
    'ok',true,'request_id',r.id,'page_id',r.page_id,'sender_id',r.sender_id,
    'synthetic_message_id',r.message_id,'source_message_id',m.message_id,'source_message_row_id',m.id,
    'customer_id',c.id,'runtime_mode',coalesce(pol.runtime_mode,rt.mode,'PRODUCTION'),
    'model_name',coalesce(rt.model_name,pr.model_name),'provider_key',pr.provider_key,
    'provider_base_url',coalesce(pr.base_url,'https://api.openai.com/v1'),
    'api_key_secret_name',coalesce(pr.api_key_secret_name,'OPENAI_API_KEY'),
    'min_confidence',coalesce(rt.min_confidence_to_reply,.78),
    'details',v_details,
    'customer',jsonb_build_object(
      'display_name',c.display_name,'preferred_salutation',c.preferred_salutation,'gender',c.gender,
      'phone',c.phone,'zalo',c.zalo,'lead_state',c.lead_state,
      'last_product_key',c.last_product_key,'last_intent_type',c.last_intent_type
    ),
    'conversation_state',to_jsonb(s),'memory',v_memory,'conversation',v_history
  );
end;
$function$;

create or replace function public.v8_complete_follow_up_ai_request(
  p_request_id uuid,
  p_decision jsonb,
  p_model_name text default null,
  p_response_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r public.v8_ai_brain_requests%rowtype;
  c public.v8_customers%rowtype;
  m public.v8_messages_raw%rowtype;
  rt public.v8_ai_brain_runtime%rowtype;
  pol record;
  v_details jsonb:='{}'::jsonb;
  v_reply text:=left(btrim(coalesce(p_decision->>'final_reply','')),260);
  v_should boolean:=coalesce((p_decision->>'should_reply')::boolean,false);
  v_conf numeric:=least(greatest(coalesce((p_decision->>'confidence')::numeric,0),0),1);
  v_decision_id uuid;
  v_plan_id uuid;
  v_now timestamptz:=now();
begin
  select * into r from public.v8_ai_brain_requests where id=p_request_id for update;
  if r.id is null or r.requested_by<>'follow_up_scan' then return jsonb_build_object('ok',false,'error','invalid_follow_up_request'); end if;
  v_details:=coalesce(r.dispatch_details,'{}'::jsonb);
  select * into c from public.v8_customers where page_id=r.page_id and sender_id=r.sender_id limit 1;
  select * into m from public.v8_messages_raw where page_id=r.page_id and message_id=v_details->>'last_inbound_message_id' limit 1;
  select * into rt from public.v8_ai_brain_runtime where page_id=r.page_id;
  select * into pol from public.v8_resolve_runtime_policy(r.page_id) limit 1;

  if c.id is null or m.id is null then return jsonb_build_object('ok',false,'error','follow_up_context_missing'); end if;
  if v_reply='' or v_conf<coalesce(rt.min_confidence_to_reply,.78) then v_should:=false; end if;
  if v_reply~*'\m[0-9][0-9.,]*[[:space:]]*(triệu|trieu|nghìn|nghin|k|đ|₫|vnd)\M' then v_should:=false; end if;
  if c.phone is not null or c.zalo is not null then v_should:=false; end if;
  if exists(select 1 from public.v8_messages_raw x where x.customer_id=c.id and x.direction='inbound' and x.sent_at>m.sent_at) then v_should:=false; end if;

  insert into public.v8_ai_decisions(
    page_id,sender_id,customer_id,message_id,source_message_row_id,runtime_mode,provider_key,model_name,
    status,customer_goal,intent_type,product_scope,catalog_key,confidence,should_reply,final_reply,
    should_send_slide,slide_asset_ids,should_request_contact,should_handoff_sale,needs_clarification,
    decision,evidence_summary,risk_flags,error,started_at,completed_at,updated_at,model_output,decision_authority
  ) values(
    r.page_id,r.sender_id,c.id,r.message_id,m.id,coalesce(pol.runtime_mode,rt.mode,'PRODUCTION'),
    coalesce(rt.provider_key,'openai'),coalesce(nullif(p_model_name,''),rt.model_name,'unknown'),
    'completed','Chăm sóc lại khách chưa phản hồi','follow_up',
    coalesce(v_details->>'group_key',c.last_product_key),c.last_catalog_key,v_conf,v_should,v_reply,
    false,'[]'::jsonb,coalesce((p_decision->>'should_request_contact')::boolean,false),false,false,
    coalesce(p_decision,'{}'::jsonb)||jsonb_build_object('trigger_context',v_details),
    jsonb_build_array(jsonb_build_object('source_type','conversation_history','source_id',m.message_id,'claim','AI đọc toàn bộ hội thoại trước khi quyết định chăm sóc lại.')),
    coalesce(p_decision->'risk_flags','[]'::jsonb),null,coalesce(r.started_at,v_now),v_now,v_now,
    jsonb_build_object('response_id',nullif(p_response_id,'')),'ai_runtime_follow_up'
  )
  on conflict(page_id,message_id) do update set
    status='completed',confidence=excluded.confidence,should_reply=excluded.should_reply,
    final_reply=excluded.final_reply,decision=excluded.decision,risk_flags=excluded.risk_flags,
    completed_at=excluded.completed_at,updated_at=excluded.updated_at,model_output=excluded.model_output,
    decision_authority='ai_runtime_follow_up'
  returning id into v_decision_id;

  if v_should then
    insert into public.v8_reply_plans(
      customer_id,queue_id,page_id,sender_id,message_id,business_group_key,intent_type,
      conversation_stage,action_type,suggested_reply,should_request_phone,should_ask_need,
      should_handoff_sale,safety_status,reason,send_eligible,blocked_reason,available_after,
      runtime_mode,is_latest_customer_turn
    ) values(
      c.id,null,r.page_id,r.sender_id,m.message_id,coalesce(v_details->>'group_key',c.last_product_key),'follow_up',
      'follow_up',coalesce(nullif(p_decision->>'action_type',''),'ai_follow_up_nudge'),v_reply,
      coalesce((p_decision->>'should_request_contact')::boolean,false),true,false,'ready_to_send',
      jsonb_build_object(
        'ai_brain',true,'ai_follow_up',true,'ai_decision_id',v_decision_id,'ai_follow_up_request_id',r.id,
        'decision_authority','ai_runtime_follow_up','care_case',v_details->>'care_case',
        'care_anchor_at',v_details->>'care_anchor_at','care_anchor_message_id',v_details->>'care_anchor_message_id',
        'confidence',v_conf,'risk_flags',coalesce(p_decision->'risk_flags','[]'::jsonb)
      ),true,null,v_now,coalesce(pol.runtime_mode,'PRODUCTION'),true
    ) returning id into v_plan_id;
  end if;

  update public.v8_ai_brain_requests
  set status='completed',decision_id=v_decision_id,completed_at=v_now,last_error=null,
      dispatch_details=v_details||jsonb_build_object('follow_up_result',jsonb_build_object(
        'should_reply',v_should,'reply_plan_id',v_plan_id,'completed_at',v_now
      ))
  where id=r.id;

  return jsonb_build_object('ok',true,'decision_id',v_decision_id,'should_reply',v_should,'reply_plan_id',v_plan_id);
end;
$function$;

create or replace function public.v8_fail_follow_up_ai_request(p_request_id uuid,p_error text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.v8_ai_brain_requests
  set status='error',completed_at=now(),last_error=left(coalesce(p_error,'follow_up_brain_error'),800)
  where id=p_request_id and requested_by='follow_up_scan';
  return jsonb_build_object('ok',true);
end;
$function$;
