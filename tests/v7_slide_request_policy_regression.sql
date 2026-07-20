-- Run after 20260720112033_restore_v7_slide_request_delivery_policy_v2.sql.
-- The transaction is always rolled back: no customer message or outbound row
-- from this regression can become visible to the live worker.

begin;

do $test$
declare
  v_page_id text:='104810069068200';
  v_sender_id text:='v7_slide_test_'||replace(gen_random_uuid()::text,'-','');
  v_customer_id uuid;
  v_source_row_id uuid;
  v_source_message_id text:='v7_source_'||gen_random_uuid()::text;
  v_queue_id uuid;
  v_slide_id uuid;
  v_outbound_id uuid;
  v_asset public.v8_drive_assets%rowtype;
  v_policy jsonb;
  v_gate record;
  v_status text;
  v_cancel_reason text;
begin
  select * into v_asset
  from public.v8_drive_assets
  where is_active and is_image and delivery_status='verified'
  order by last_seen_at desc
  limit 1;
  if v_asset.id is null then raise exception 'TEST_REQUIRES_ONE_VERIFIED_ASSET'; end if;

  insert into public.v8_customers(page_id,page_name,sender_id,display_name,first_seen_at,last_seen_at)
  values(v_page_id,'Tổng Kho Thiết Bị Bếp & Nhà Tắm Miền Bắc',v_sender_id,'V7 slide regression',now(),now())
  returning id into v_customer_id;

  insert into public.v8_messages_raw(
    customer_id,page_id,sender_id,conversation_id,message_id,direction,actor_type,
    message_text,attachments,raw_payload,sent_at,source_system,is_automatic
  ) values(
    v_customer_id,v_page_id,v_sender_id,v_sender_id,v_source_message_id,'inbound','customer',
    'Gửi ảnh sản phẩm cho mình xem nhé','[]'::jsonb,'{}'::jsonb,now()-interval '20 seconds','regression_test',false
  ) returning id into v_source_row_id;

  insert into public.v8_processing_queue(
    queue_type,page_id,sender_id,message_id,customer_id,product_key,catalog_key,
    intent_type,payload,status,processed_at,validation_status,validation_code
  ) values(
    'core_message',v_page_id,v_sender_id,v_source_message_id,v_customer_id,
    coalesce(v_asset.product_key,'regression_product'),coalesce(v_asset.catalog_key,'regression_catalog'),
    'ask_sample','{}'::jsonb,'done',now()-interval '15 seconds','passed','VALID'
  ) returning id into v_queue_id;

  insert into public.v8_slide_logs(
    customer_id,message_id,page_id,sender_id,product_key,catalog_key,folder_path,
    slide_url,send_status,decision_status,safety_status,reason,asset_id
  ) values(
    v_customer_id,v_source_row_id,v_page_id,v_sender_id,
    coalesce(v_asset.product_key,'regression_product'),coalesce(v_asset.catalog_key,'regression_catalog'),
    v_asset.parent_folder_name,coalesce(v_asset.delivery_url,v_asset.file_url),
    'queued','ready','ready_to_send',jsonb_build_object('queue_id',v_queue_id),v_asset.id
  ) returning id into v_slide_id;

  select id into v_outbound_id
  from public.v8_outbound_queue
  where slide_log_id=v_slide_id;

  v_policy:=public.v8_v7_slide_outbound_policy(v_outbound_id);
  if not coalesce((v_policy->>'allow_delivery')::boolean,false) then
    raise exception 'EXPECTED_V7_SLIDE_ALLOWED_BEFORE_EXTERNAL_REPLY: %',v_policy;
  end if;

  insert into public.v8_messages_raw(
    customer_id,page_id,sender_id,conversation_id,message_id,direction,actor_type,actor_name,
    message_text,attachments,raw_payload,sent_at,source_system,is_automatic,source_detail
  ) values(
    v_customer_id,v_page_id,v_sender_id,v_sender_id,'v7_external_'||gen_random_uuid()::text,
    'outbound','page_or_system','AIcake',
    'Đây là một vài mẫu bán chạy. Anh/chị kết nối qua SĐT/Zalo để xem thêm mẫu nhé.',
    '[]'::jsonb,'{}'::jsonb,now()-interval '10 seconds','meta_page_history',null,
    jsonb_build_object('classification','page_history_preflight')
  );

  select status,cancel_reason into v_status,v_cancel_reason
  from public.v8_outbound_queue where id=v_outbound_id;
  if v_status<>'ready' then
    raise exception 'SALE_OR_AICAKE_TEXT_MUST_NOT_CANCEL_SLIDE: status %, reason %',v_status,v_cancel_reason;
  end if;

  select * into v_gate from public.v8_evaluate_outbound_gate(v_outbound_id) limit 1;
  if not coalesce(v_gate.allowed,false) then
    raise exception 'FINAL_GATE_MUST_ALLOW_V7_SLIDE_AFTER_EXTERNAL_TEXT: % %',v_gate.reason,v_gate.details;
  end if;

  insert into public.v8_messages_raw(
    customer_id,page_id,sender_id,conversation_id,message_id,direction,actor_type,
    message_text,attachments,raw_payload,sent_at,source_system,is_automatic
  ) values(
    v_customer_id,v_page_id,v_sender_id,v_sender_id,'v7_phone_'||gen_random_uuid()::text,
    'inbound','customer','Số của mình 0988123456 nhé','[]'::jsonb,'{}'::jsonb,now(),'regression_test',false
  );

  select status,cancel_reason into v_status,v_cancel_reason
  from public.v8_outbound_queue where id=v_outbound_id;
  if v_status<>'cancelled' or lower(coalesce(v_cancel_reason,''))<>'customer_contact_provided' then
    raise exception 'PHONE_MUST_CANCEL_V7_SLIDE: status %, reason %',v_status,v_cancel_reason;
  end if;
end;
$test$;

rollback;
