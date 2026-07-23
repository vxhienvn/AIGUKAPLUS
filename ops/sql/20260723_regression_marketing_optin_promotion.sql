begin;

create temporary table _promo_test_result(result jsonb) on commit drop;

do $test$
declare
  v_sender text:='regression-promo-'||replace(gen_random_uuid()::text,'-','');
  v_first jsonb;
  v_second jsonb;
  v_stop jsonb;
  v_customer uuid;
  v_outbound uuid;
  v_gate record;
  v_payload jsonb;
  v_delivery_count integer;
begin
  v_first:=public.v8_record_marketing_optin(
    '104810069068200',v_sender,
    jsonb_build_object(
      'type','notification_messages',
      'payload','showroom_promotions',
      'title','NHẬN TOÀN BỘ ƯU ĐÃI THÁNG 7–8/2026',
      'notification_messages_token','test-token-'||v_sender,
      'token_expiry_timestamp',((extract(epoch from now()+interval '30 days')*1000)::bigint)::text,
      'notification_messages_timezone','Asia/Bangkok'
    ),
    now()-interval '1 minute',
    jsonb_build_object('regression_test',true)
  );

  select id into v_customer
  from public.v8_customers
  where page_id='104810069068200' and sender_id=v_sender;

  select outbound_id into v_outbound
  from public.v8_promotion_delivery_log
  where customer_id=v_customer;

  update public.v8_outbound_queue
  set due_at=now()-interval '1 second'
  where id=v_outbound;

  select * into v_gate from public.v8_evaluate_outbound_gate(v_outbound);
  select payload into v_payload from public.v8_outbound_queue where id=v_outbound;

  v_second:=public.v8_record_marketing_optin(
    '104810069068200',v_sender,
    jsonb_build_object(
      'type','notification_messages',
      'payload','showroom_promotions',
      'notification_messages_token','test-token-'||v_sender
    ),
    now(),
    jsonb_build_object('regression_test',true,'duplicate',true)
  );

  select count(*) into v_delivery_count
  from public.v8_promotion_delivery_log
  where customer_id=v_customer;

  v_stop:=public.v8_record_marketing_optin(
    '104810069068200',v_sender,
    jsonb_build_object(
      'type','notification_messages',
      'payload','showroom_promotions',
      'notification_messages_token','test-token-'||v_sender,
      'notification_messages_status','STOP_NOTIFICATIONS'
    ),
    now(),
    jsonb_build_object('regression_test',true,'stop',true)
  );

  insert into _promo_test_result(result)
  values(jsonb_build_object(
    'ok',
      coalesce((v_first->'stage_result'->>'staged')::boolean,false)
      and coalesce(v_gate.allowed,false)
      and jsonb_array_length(coalesce(v_payload->'elements','[]'::jsonb))=6
      and v_payload->>'notification_messages_token'='test-token-'||v_sender
      and v_delivery_count=1
      and v_stop->>'status'='stopped',
    'gate',jsonb_build_object('allowed',v_gate.allowed,'reason',v_gate.reason,'details',v_gate.details),
    'element_count',jsonb_array_length(coalesce(v_payload->'elements','[]'::jsonb)),
    'zalo_buttons',(
      select count(*)
      from jsonb_array_elements(v_payload->'elements') e,
           jsonb_array_elements(e->'buttons') b
      where b->>'url'='https://zalo.me/0989882690'
    ),
    'delivery_count_after_duplicate',v_delivery_count,
    'first',v_first,
    'second',v_second,
    'stop',v_stop
  ));
end;
$test$;

select result from _promo_test_result;
rollback;
