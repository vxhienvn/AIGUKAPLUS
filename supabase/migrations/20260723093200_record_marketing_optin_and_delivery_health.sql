create or replace function public.v8_record_marketing_optin(
  p_page_id text,
  p_sender_id text,
  p_optin jsonb,
  p_event_time timestamptz default now(),
  p_raw_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path='public'
as $function$
declare
  v_customer_id uuid;
  v_page_name text;
  v_topic_key text:='showroom_promotions';
  v_token text:=nullif(btrim(coalesce(p_optin->>'notification_messages_token','')),'');
  v_notification_status text:=upper(coalesce(nullif(p_optin->>'notification_messages_status',''),'ACTIVE'));
  v_stopped boolean:=false;
  v_expires_at timestamptz;
  v_subscription_id uuid;
  v_source_message_id text;
  v_source_row_id uuid;
  v_stage jsonb:='{}'::jsonb;
begin
  if nullif(btrim(coalesce(p_page_id,'')),'') is null or nullif(btrim(coalesce(p_sender_id,'')),'') is null then
    return jsonb_build_object('ok',false,'reason','page_or_sender_missing');
  end if;

  select page_name into v_page_name from public.v8_pages where page_id=p_page_id limit 1;
  insert into public.v8_customers(page_id,page_name,sender_id,first_seen_at,last_seen_at)
  values(p_page_id,v_page_name,p_sender_id,coalesce(p_event_time,now()),coalesce(p_event_time,now()))
  on conflict(page_id,sender_id) do update set last_seen_at=greatest(public.v8_customers.last_seen_at,excluded.last_seen_at)
  returning id into v_customer_id;

  v_stopped:=v_notification_status='STOP_NOTIFICATIONS';
  begin
    if coalesce(p_optin->>'token_expiry_timestamp','') ~ '^[0-9]+$' then
      v_expires_at:=to_timestamp((p_optin->>'token_expiry_timestamp')::numeric/1000.0);
    end if;
  exception when others then v_expires_at:=null; end;

  insert into public.v8_marketing_message_subscriptions(
    page_id,sender_id,customer_id,topic_key,notification_messages_token,status,
    notification_status,title,payload,timezone,expires_at,opted_in_at,opted_out_at,last_event_at,raw_optin,updated_at
  ) values(
    p_page_id,p_sender_id,v_customer_id,v_topic_key,v_token,
    case when v_stopped then 'stopped' else 'active' end,
    v_notification_status,p_optin->>'title',p_optin->>'payload',p_optin->>'notification_messages_timezone',
    v_expires_at,case when v_stopped then null else coalesce(p_event_time,now()) end,
    case when v_stopped then coalesce(p_event_time,now()) else null end,
    coalesce(p_event_time,now()),coalesce(p_optin,'{}'::jsonb),now()
  )
  on conflict(page_id,sender_id,topic_key) do update set
    customer_id=excluded.customer_id,
    notification_messages_token=coalesce(excluded.notification_messages_token,public.v8_marketing_message_subscriptions.notification_messages_token),
    status=excluded.status,
    notification_status=excluded.notification_status,
    title=coalesce(excluded.title,public.v8_marketing_message_subscriptions.title),
    payload=coalesce(excluded.payload,public.v8_marketing_message_subscriptions.payload),
    timezone=coalesce(excluded.timezone,public.v8_marketing_message_subscriptions.timezone),
    expires_at=coalesce(excluded.expires_at,public.v8_marketing_message_subscriptions.expires_at),
    opted_in_at=case when excluded.status='active' then excluded.last_event_at else public.v8_marketing_message_subscriptions.opted_in_at end,
    opted_out_at=case when excluded.status='stopped' then excluded.last_event_at else null end,
    last_event_at=excluded.last_event_at,
    raw_optin=excluded.raw_optin,
    updated_at=now()
  returning id into v_subscription_id;

  if v_stopped then
    return jsonb_build_object('ok',true,'recorded',true,'status','stopped','subscription_id',v_subscription_id,'staged',false);
  end if;
  if v_token is null then
    return jsonb_build_object('ok',true,'recorded',true,'status','active_without_token','subscription_id',v_subscription_id,'staged',false);
  end if;

  v_source_message_id:='marketing_optin:'||md5(p_page_id||':'||p_sender_id||':'||v_token||':'||coalesce(p_event_time,now())::text);
  insert into public.v8_messages_raw(
    customer_id,page_id,sender_id,message_id,direction,actor_type,message_text,attachments,raw_payload,
    sent_at,actor_name,source_system,is_automatic,actor_confidence,source_detail
  ) values(
    v_customer_id,p_page_id,p_sender_id,v_source_message_id,'system','meta_system',
    'Khách đã đồng ý nhận chương trình ưu đãi','[]'::jsonb,coalesce(p_raw_payload,'{}'::jsonb),
    coalesce(p_event_time,now()),'Meta marketing opt-in','meta_marketing_optin',true,'verified',
    jsonb_build_object('classification','marketing_messages_optin','subscription_id',v_subscription_id,'notification_status',v_notification_status)
  )
  on conflict(page_id,message_id) do update set raw_payload=excluded.raw_payload,source_detail=excluded.source_detail
  returning id into v_source_row_id;

  v_stage:=public.v8_stage_showroom_promotion(v_customer_id,v_source_row_id,'meta_marketing_optin',false);
  return jsonb_build_object(
    'ok',true,'recorded',true,'status','active','subscription_id',v_subscription_id,
    'source_message_row_id',v_source_row_id,'stage_result',v_stage
  );
end;
$function$;

create or replace function public.v8_sync_promotion_delivery_status()
returns trigger
language plpgsql
security definer
set search_path='public'
as $function$
declare
  v_delivery_id uuid;
begin
  begin
    v_delivery_id:=nullif(new.payload->>'promotion_delivery_id','')::uuid;
  exception when others then v_delivery_id:=null; end;
  if v_delivery_id is null then return new; end if;

  update public.v8_promotion_delivery_log
  set status=case
        when new.status='sent' then 'sent'
        when new.status='cancelled' then 'cancelled'
        when new.status='failed' then 'failed'
        when new.status='sending' then 'sending'
        else 'queued'
      end,
      details=details||jsonb_build_object(
        'outbound_status',new.status,
        'sent_at',new.sent_at,
        'cancel_reason',new.cancel_reason,
        'last_error',new.last_error
      ),
      updated_at=now()
  where id=v_delivery_id;
  return new;
end;
$function$;

drop trigger if exists trg_v8_sync_promotion_delivery_status on public.v8_outbound_queue;
create trigger trg_v8_sync_promotion_delivery_status
after insert or update of status,sent_at,cancel_reason,last_error on public.v8_outbound_queue
for each row execute function public.v8_sync_promotion_delivery_status();

create or replace function public.v8_marketing_promotion_health()
returns jsonb
language sql
stable security definer
set search_path='public'
as $function$
  select jsonb_build_object(
    'subscriptions',jsonb_build_object(
      'active',(select count(*) from public.v8_marketing_message_subscriptions where status='active' and (expires_at is null or expires_at>now())),
      'stopped',(select count(*) from public.v8_marketing_message_subscriptions where status='stopped'),
      'expired',(select count(*) from public.v8_marketing_message_subscriptions where expires_at is not null and expires_at<=now())
    ),
    'deliveries',jsonb_build_object(
      'queued',(select count(*) from public.v8_promotion_delivery_log where status in ('preparing','queued','sending')),
      'sent',(select count(*) from public.v8_promotion_delivery_log where status='sent'),
      'failed_or_cancelled',(select count(*) from public.v8_promotion_delivery_log where status in ('failed','cancelled'))
    ),
    'config',(select value from public.v8_config_hub where scope='promotion' and key='showroom_event_202607_full_carousel' and is_active order by updated_at desc limit 1)
  );
$function$;

revoke all on function public.v8_record_marketing_optin(text,text,jsonb,timestamptz,jsonb) from public,anon,authenticated;
revoke all on function public.v8_stage_showroom_promotion(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.v8_record_marketing_optin(text,text,jsonb,timestamptz,jsonb) to service_role;
grant execute on function public.v8_stage_showroom_promotion(uuid,uuid,text,boolean) to service_role;
grant execute on function public.v8_marketing_promotion_health() to service_role;

update public.v8_ai_contexts
set content=replace(
      content,
      'Áp dụng riêng cho Page Tổng Kho Thiết Bị Bếp & Nhà Tắm Miền Bắc, page_id 104810069068200.',
      'Áp dụng cho cả Page Tổng Kho Thiết Bị Bếp & Nhà Tắm Miền Bắc (104810069068200) và Page GUKA – Nội thất phòng khách số 1 Việt Nam (985632314640803).'
    ),
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
      'page_ids',jsonb_build_array('104810069068200','985632314640803'),
      'full_promotion_carousel_key','showroom_event_202607_full_carousel',
      'zalo_url','https://zalo.me/0989882690',
      'promotion_scope_updated_at',now()
    ),
    updated_at=now()
where context_key='tong_kho_showroom_event_202607';
