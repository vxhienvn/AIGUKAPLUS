create or replace function public.v8_is_combo_bath_kitchen_postback(p_text text)
returns boolean
language sql
stable
set search_path='public'
as $function$
  select public.v8_normalize_detector_text(coalesce(p_text,'')) in (
    'tu van nha tam nha bep',
    'tu van nha tam va nha bep',
    'tu van combo nha tam nha bep',
    'tu van combo nha tam va nha bep'
  );
$function$;

create or replace function public.v8_contact_capture_salutation(p_customer_id uuid)
returns text
language plpgsql
stable
set search_path='public'
as $function$
declare
  v_sal text;
  v_norm text;
begin
  select preferred_salutation into v_sal
  from public.v8_customers
  where id=p_customer_id;

  v_norm:=public.v8_normalize_detector_text(coalesce(v_sal,''));
  return case v_norm
    when 'anh' then 'Anh'
    when 'chi' then 'Chị'
    when 'co' then 'Cô'
    when 'chu' then 'Chú'
    when 'em' then 'Em'
    else 'Mình'
  end;
end;
$function$;

create or replace function public.v8_enforce_product_contact_capture()
returns trigger
language plpgsql
security definer
set search_path='public'
as $function$
declare
  v_has_contact boolean:=false;
  v_salutation text:='Mình';
  v_norm_reply text;
  v_source_text text;
  v_is_combo_postback boolean:=false;
  v_contact_required boolean:=false;
  v_contact_sentence text;
begin
  if new.status<>'completed' or not coalesce(new.should_reply,false) then
    return new;
  end if;

  if tg_op='UPDATE' and old.status='completed'
     and new.final_reply is not distinct from old.final_reply
     and new.should_request_contact is not distinct from old.should_request_contact then
    return new;
  end if;

  select coalesce(c.phone is not null or c.zalo is not null,false)
         or coalesce(s.has_phone,false),
         public.v8_contact_capture_salutation(new.customer_id)
    into v_has_contact,v_salutation
  from public.v8_customers c
  left join public.v8_conversation_states s on s.customer_id=c.id
  where c.id=new.customer_id;

  v_has_contact:=coalesce(v_has_contact,false);
  v_salutation:=coalesce(nullif(v_salutation,''),'Mình');

  select m.message_text into v_source_text
  from public.v8_messages_raw m
  where m.page_id=new.page_id and m.message_id=new.message_id
  order by m.created_at desc
  limit 1;

  v_is_combo_postback:=public.v8_is_combo_bath_kitchen_postback(v_source_text);
  v_contact_required:=not v_has_contact and coalesce(new.intent_type,'') in (
    'ask_price','ask_product_info','ask_sample','purchase_intent'
  );

  if v_is_combo_postback then
    if v_has_contact then
      new.final_reply:='Dạ, combo nhà tắm và nhà bếp có nhiều hạng mục và cấu hình. Em đã ghi nhận liên hệ của mình, bên em sẽ tư vấn, chọn mẫu và báo giá kèm ưu đãi phù hợp ạ.';
      new.should_request_contact:=false;
      new.should_handoff_sale:=true;
    else
      new.final_reply:='Dạ, combo nhà tắm và nhà bếp có nhiều hạng mục và cấu hình. '||v_salutation||' cho em xin số điện thoại hoặc Zalo, em tư vấn, chọn mẫu và báo giá kèm ưu đãi cho mình tiện hơn ạ.';
      new.should_request_contact:=true;
      new.should_handoff_sale:=false;
    end if;
    new.needs_clarification:=false;
    new.product_scope:='multi_product';
    new.catalog_key:='multi_product';
  elsif v_contact_required then
    new.should_request_contact:=true;
    v_norm_reply:=public.v8_normalize_detector_text(coalesce(new.final_reply,''));
    if v_norm_reply !~ '(so dien thoai|sdt|zalo|thong tin lien he)' then
      v_contact_sentence:=v_salutation||' cho em xin số điện thoại hoặc Zalo, em tư vấn, chọn mẫu và báo giá kèm ưu đãi cho mình tiện hơn ạ.';
      new.final_reply:=rtrim(coalesce(new.final_reply,''));
      if new.final_reply<>'' and right(new.final_reply,1) not in ('.','!','?') then
        new.final_reply:=new.final_reply||'.';
      end if;
      new.final_reply:=btrim(new.final_reply||' '||v_contact_sentence);
    end if;
  end if;

  if new.decision is not null and jsonb_typeof(new.decision)='object' then
    new.decision:=jsonb_set(new.decision,'{final_reply}',to_jsonb(new.final_reply),true);
    new.decision:=jsonb_set(new.decision,'{should_request_contact}',to_jsonb(new.should_request_contact),true);
    new.decision:=jsonb_set(new.decision,'{should_handoff_sale}',to_jsonb(new.should_handoff_sale),true);
    new.decision:=jsonb_set(new.decision,'{needs_clarification}',to_jsonb(new.needs_clarification),true);
    if v_is_combo_postback then
      new.decision:=jsonb_set(new.decision,'{product_scope}',to_jsonb('multi_product'::text),true);
      new.decision:=jsonb_set(new.decision,'{catalog_keys}','["combo_phong_tam","bep_tu_hut_mui"]'::jsonb,true);
      new.decision:=jsonb_set(new.decision,'{action_type}',to_jsonb(case when new.should_handoff_sale then 'handoff_sale' else 'reply_text' end),true);
      new.decision:=jsonb_set(new.decision,'{clarification_question}','null'::jsonb,true);
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_v8_000_enforce_product_contact_capture on public.v8_ai_decisions;
create trigger trg_v8_000_enforce_product_contact_capture
before insert or update on public.v8_ai_decisions
for each row execute function public.v8_enforce_product_contact_capture();

create or replace function public.v8_zero_token_combo_postback_request()
returns trigger
language plpgsql
security definer
set search_path='public'
as $function$
declare
  v_message public.v8_messages_raw%rowtype;
  v_customer public.v8_customers%rowtype;
  v_runtime_mode text:='ACTIVE';
  v_salutation text:='Mình';
  v_has_contact boolean:=false;
  v_reply text;
  v_decision_id uuid;
  v_now timestamptz:=now();
  v_decision jsonb;
begin
  if new.status<>'pending' or coalesce(new.requested_by,'')='follow_up_scan' then
    return new;
  end if;

  select * into v_message
  from public.v8_messages_raw
  where page_id=new.page_id and message_id=new.message_id
  order by created_at desc
  limit 1;

  if v_message.id is null
     or v_message.direction<>'inbound'
     or v_message.actor_type<>'customer'
     or not public.v8_is_combo_bath_kitchen_postback(v_message.message_text) then
    return new;
  end if;

  select * into v_customer
  from public.v8_customers
  where id=v_message.customer_id
     or (page_id=new.page_id and sender_id=new.sender_id)
  order by case when id=v_message.customer_id then 0 else 1 end
  limit 1;

  select coalesce(mode,'ACTIVE') into v_runtime_mode
  from public.v8_ai_brain_runtime
  where page_id=new.page_id;
  v_runtime_mode:=coalesce(v_runtime_mode,'ACTIVE');

  v_salutation:=public.v8_contact_capture_salutation(v_customer.id);
  v_has_contact:=coalesce(v_customer.phone is not null or v_customer.zalo is not null,false)
    or coalesce((select has_phone from public.v8_conversation_states where customer_id=v_customer.id),false);

  if v_has_contact then
    v_reply:='Dạ, combo nhà tắm và nhà bếp có nhiều hạng mục và cấu hình. Em đã ghi nhận liên hệ của mình, bên em sẽ tư vấn, chọn mẫu và báo giá kèm ưu đãi phù hợp ạ.';
  else
    v_reply:='Dạ, combo nhà tắm và nhà bếp có nhiều hạng mục và cấu hình. '||coalesce(nullif(v_salutation,''),'Mình')||' cho em xin số điện thoại hoặc Zalo, em tư vấn, chọn mẫu và báo giá kèm ưu đãi cho mình tiện hơn ạ.';
  end if;

  v_decision:=jsonb_build_object(
    'customer_goal','Tư vấn combo nhà tắm và nhà bếp',
    'intent_type','ask_product_info',
    'product_scope','multi_product',
    'catalog_keys',jsonb_build_array('combo_phong_tam','bep_tu_hut_mui'),
    'conversation_stage',case when v_has_contact then 'handoff' else 'evaluating' end,
    'action_type',case when v_has_contact then 'handoff_sale' else 'reply_text' end,
    'confidence',1.0,
    'should_reply',true,
    'final_reply',v_reply,
    'needs_clarification',false,
    'clarification_question',null,
    'should_send_slide',false,
    'should_request_contact',not v_has_contact,
    'should_handoff_sale',v_has_contact,
    'evidence_summary',jsonb_build_array(jsonb_build_object(
      'source_type','fixed_postback_mapping','source_id',v_message.message_id,
      'claim','Khách chọn tư vấn đồng thời nhóm nhà tắm và nhà bếp'
    )),
    'risk_flags','[]'::jsonb,
    'reason','Postback cố định đã được mapping; xin liên hệ để tư vấn cấu hình, chọn mẫu và báo giá, không cần gọi model.',
    'memory_update',jsonb_build_object(
      'active_goal','Tư vấn combo nhà tắm và nhà bếp',
      'summary','Khách quan tâm đồng thời combo nhà tắm và nhà bếp.',
      'product_scope','multi_product',
      'contact_status',case when v_has_contact then 'captured' else 'requested' end,
      'pending_actions',case when v_has_contact then jsonb_build_array('Chuyển Sale tư vấn và báo giá') else jsonb_build_array('Chờ khách cung cấp SĐT/Zalo') end
    ),
    'slide_selection_mode','system_from_catalog_mapping'
  );

  insert into public.v8_ai_decisions(
    page_id,sender_id,customer_id,message_id,source_message_row_id,runtime_mode,
    provider_key,model_name,status,customer_goal,intent_type,product_scope,catalog_key,
    confidence,should_reply,final_reply,should_send_slide,slide_asset_ids,
    should_request_contact,should_handoff_sale,needs_clarification,decision,
    evidence_summary,risk_flags,error,started_at,completed_at,updated_at,
    decision_authority,prompt_version,model_calls,context_bytes,input_tokens,
    output_tokens,total_tokens,cached_input_tokens,reasoning_tokens,usage_details
  ) values (
    new.page_id,new.sender_id,v_customer.id,new.message_id,v_message.id,v_runtime_mode,
    'deterministic_rule','rule_zero_token_v1','completed','Tư vấn combo nhà tắm và nhà bếp',
    'ask_product_info','multi_product','multi_product',1.0,true,v_reply,false,'[]'::jsonb,
    not v_has_contact,v_has_contact,false,v_decision,
    v_decision->'evidence_summary','[]'::jsonb,null,v_now,v_now,v_now,
    'ai_runtime_rule_postback','postback_combo_contact_zero_token_v1',0,
    octet_length(v_reply),0,0,0,0,0,jsonb_build_object('mode','deterministic_zero_token')
  )
  on conflict(page_id,message_id) do update set
    status='completed',
    final_reply=excluded.final_reply,
    should_request_contact=excluded.should_request_contact,
    should_handoff_sale=excluded.should_handoff_sale,
    needs_clarification=false,
    decision=excluded.decision,
    completed_at=excluded.completed_at,
    updated_at=excluded.updated_at,
    decision_authority=excluded.decision_authority,
    prompt_version=excluded.prompt_version,
    model_calls=0,input_tokens=0,output_tokens=0,total_tokens=0,
    usage_details=excluded.usage_details
  returning id into v_decision_id;

  update public.v8_ai_brain_requests
  set status='completed',decision_id=v_decision_id,completed_at=v_now,last_error=null,
      dispatch_details=coalesce(dispatch_details,'{}'::jsonb)||jsonb_build_object(
        'zero_token_postback',true,
        'prompt_version','postback_combo_contact_zero_token_v1',
        'model_calls',0,'input_tokens',0,'output_tokens',0,'total_tokens',0,
        'contact_requested',not v_has_contact
      )
  where id=new.id;

  return new;
end;
$function$;

drop trigger if exists trg_v8_zero_token_combo_postback_request on public.v8_ai_brain_requests;
create trigger trg_v8_zero_token_combo_postback_request
after insert on public.v8_ai_brain_requests
for each row execute function public.v8_zero_token_combo_postback_request();

insert into public.v8_prompt_branches(
  branch_key,branch_name,trigger_description,conditions,instruction_text,
  example_customer_message,example_good_reply,priority,is_active,created_by,prompt_group_key,updated_at
) values (
  'product_contact_capture_required_v1',
  'Hỏi sản phẩm phải xin liên hệ',
  'Khách hỏi giá, mẫu, sản phẩm, nhóm sản phẩm, combo nhà tắm hoặc nhà bếp khi chưa có SĐT/Zalo',
  jsonb_build_object('intents',jsonb_build_array('ask_price','ask_product_info','ask_sample','purchase_intent'),'requires_no_contact',true),
  'Khi khách hỏi hoặc chọn sản phẩm/nhóm sản phẩm mà chưa có SĐT/Zalo, phải xin số điện thoại hoặc Zalo để tư vấn, chọn mẫu và báo giá kèm ưu đãi. Nếu khách quan tâm đồng thời combo nhà tắm và nhà bếp thì không bắt chọn lại một nhóm; nói hai nhóm có nhiều hạng mục, cấu hình rồi xin liên hệ ngay.',
  'Tư vấn nhà tắm/nhà bếp...',
  'Dạ, combo nhà tắm và nhà bếp có nhiều hạng mục và cấu hình. Anh cho em xin số điện thoại hoặc Zalo, em tư vấn, chọn mẫu và báo giá kèm ưu đãi cho mình tiện hơn ạ.',
  1,true,'admin',null,now()
)
on conflict(branch_key) do update set
  branch_name=excluded.branch_name,
  trigger_description=excluded.trigger_description,
  conditions=excluded.conditions,
  instruction_text=excluded.instruction_text,
  example_customer_message=excluded.example_customer_message,
  example_good_reply=excluded.example_good_reply,
  priority=excluded.priority,
  is_active=true,
  prompt_group_key=null,
  updated_at=now();

insert into public.v8_reply_templates(
  template_key,template_name,stage,intent_type,business_group_key,body,
  priority,is_active,metadata,prompt_group_key,updated_at
) values (
  'capture_combo_bath_kitchen_contact',
  'Xin liên hệ cho combo nhà tắm và nhà bếp',
  'capture','ask_product_info','multi_product',
  'Dạ, combo nhà tắm và nhà bếp có nhiều hạng mục và cấu hình. {Salutation} cho em xin số điện thoại hoặc Zalo, em tư vấn, chọn mẫu và báo giá kèm ưu đãi cho mình tiện hơn ạ.',
  100,true,jsonb_build_object('zero_token_postback',true,'contact_required',true),
  null,now()
)
on conflict(template_key) do update set
  template_name=excluded.template_name,
  stage=excluded.stage,
  intent_type=excluded.intent_type,
  business_group_key=excluded.business_group_key,
  body=excluded.body,
  priority=excluded.priority,
  is_active=true,
  metadata=excluded.metadata,
  prompt_group_key=null,
  updated_at=now();

insert into public.v8_config_hub(scope,key,value,description,is_active,updated_at)
values(
  'conversation','product_contact_capture_policy',
  jsonb_build_object(
    'enabled',true,
    'version','product_contact_capture_v1',
    'required_intents',jsonb_build_array('ask_price','ask_product_info','ask_sample','purchase_intent'),
    'combo_bath_kitchen_postback_zero_token',true,
    'contact_channels',jsonb_build_array('phone','zalo'),
    'required_outcome','consult_select_sample_quote_with_promotion'
  ),
  'Bắt buộc xin SĐT/Zalo khi khách hỏi sản phẩm hoặc nhóm sản phẩm; postback combo nhà tắm/nhà bếp xử lý bằng rule 0 token.',
  true,now()
)
on conflict(scope,key) do update set value=excluded.value,description=excluded.description,is_active=true,updated_at=now();