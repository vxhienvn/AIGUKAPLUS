create or replace function public.v8_ai_authority_regression_test()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  b public.v8_ai_decisions%rowtype;
  v_id uuid:=gen_random_uuid();
  v_message_id text:='authority_test_'||gen_random_uuid()::text;
  v_original text:='Dạ sản phẩm thử nghiệm có giá 10 triệu ạ.';
  v_saved text;
  v_model text;
  v_advisory boolean:=false;
  v_immutable boolean:=false;
begin
  select * into b from public.v8_ai_decisions order by created_at desc limit 1;
  if b.id is null then return jsonb_build_object('ok',false,'reason','NO_BASE_DECISION'); end if;

  insert into public.v8_ai_decisions(
    id,snapshot_id,page_id,sender_id,customer_id,message_id,source_message_row_id,
    runtime_mode,provider_key,model_name,status,customer_goal,intent_type,product_scope,catalog_key,
    confidence,should_reply,final_reply,should_send_slide,slide_asset_ids,should_request_contact,
    should_handoff_sale,needs_clarification,decision,evidence_summary,risk_flags,
    started_at,completed_at,created_at,updated_at
  ) values(
    v_id,b.snapshot_id,b.page_id,b.sender_id,b.customer_id,v_message_id,b.source_message_row_id,
    b.runtime_mode,b.provider_key,b.model_name,'completed','Kiểm tra quyền quyết định AI','ask_price',b.product_scope,b.catalog_key,
    0.99,true,v_original,false,'[]'::jsonb,false,false,false,
    jsonb_build_object('final_reply',v_original,'should_reply',true),
    '[]'::jsonb,'["price_not_checked"]'::jsonb,now(),now(),now(),now()
  );

  select final_reply,model_output->>'final_reply',exists(
    select 1 from jsonb_array_elements(rule_advisories) e(value)
    where e.value->>'source'='price_safety_rule' and e.value->>'severity'='block'
  ) into v_saved,v_model,v_advisory
  from public.v8_ai_decisions where id=v_id;

  begin
    update public.v8_ai_decisions set final_reply='replacement_test' where id=v_id;
  exception when others then
    v_immutable:=position('AI_DECISION_AUTHORITY_VIOLATION' in sqlerrm)>0;
  end;

  delete from public.v8_ai_decisions where id=v_id;
  return jsonb_build_object(
    'ok',v_saved=v_original and v_model=v_original and v_advisory and v_immutable,
    'ai_reply_preserved',v_saved=v_original,
    'model_snapshot_preserved',v_model=v_original,
    'rule_became_advisory',v_advisory,
    'post_ai_override_blocked',v_immutable
  );
exception when others then
  delete from public.v8_ai_decisions where id=v_id;
  return jsonb_build_object('ok',false,'error',sqlerrm);
end;
$$;