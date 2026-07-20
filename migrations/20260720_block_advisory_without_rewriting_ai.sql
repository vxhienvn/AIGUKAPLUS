create or replace function public.v8_ai_stage_decision(p_decision_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','extensions'
as $$
declare
  d public.v8_ai_decisions%rowtype;
  r public.v8_ai_brain_runtime%rowtype;
  m public.v8_messages_raw%rowtype;
  s public.v8_conversation_states%rowtype;
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

  insert into public.v8_reply_plans(
    customer_id,page_id,sender_id,message_id,business_group_key,intent_type,conversation_stage,action_type,suggested_reply,
    should_request_phone,should_ask_need,should_handoff_sale,safety_status,reason,send_eligible,blocked_reason,runtime_mode,is_latest_customer_turn
  ) values(
    d.customer_id,d.page_id,d.sender_id,d.message_id,d.product_scope,d.intent_type,
    coalesce(nullif(d.decision->>'conversation_stage',''),'ai_decided'),
    coalesce(nullif(d.decision->>'action_type',''),'ai_response'),d.final_reply,
    d.should_request_contact,d.needs_clarification,d.should_handoff_sale,'ready_to_send',
    jsonb_build_object(
      'ai_brain',true,'ai_decision_id',d.id,'provider_key',d.provider_key,'model_name',d.model_name,
      'confidence',d.confidence,'evidence_summary',d.evidence_summary,'risk_flags',d.risk_flags,
      'rule_advisories',d.rule_advisories,'decision_authority',d.decision_authority
    ),
    true,null,'PRODUCTION',true
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
  return jsonb_build_object('ok',true,'staged',true,'reply_plan_id',v_reply_plan_id,'slides_staged',v_slide_count,'decision_authority','ai');
end;
$$;