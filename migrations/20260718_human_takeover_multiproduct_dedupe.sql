-- AIGUKA: chặn bot chen ngang, hiểu nhiều nhóm sản phẩm và chống hỏi lặp.
-- Mọi thay đổi đều tương thích ngược: business_group_key đơn vẫn giữ nguyên,
-- danh sách nhiều nhóm được lưu thêm trong metadata/product_intents.

insert into public.v8_business_group_aliases(group_key,alias,priority,is_active,source,updated_at)
values ('combo_phong_tam','combo tắm',9,true,'human_takeover_multi_product_fix',now())
on conflict(group_key,alias) do update
set priority=least(public.v8_business_group_aliases.priority,excluded.priority),
    is_active=true,
    source=excluded.source,
    updated_at=now();

create or replace function public.v8_reply_fingerprint(p_text text)
returns text
language sql
immutable
set search_path to 'public','extensions'
as $function$
  select regexp_replace(lower(unaccent(coalesce(p_text,''))),'[^a-z0-9]+','','g');
$function$;

create or replace function public.v8_is_explicit_multi_product(input_text text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public','extensions'
as $function$
declare
  v_norm text:=public.v8_normalize_detector_text(coalesce(input_text,''));
  v_pad text;
  v_context jsonb:=public.v8_resolve_group_context(coalesce(input_text,''));
  v_count integer:=0;
begin
  v_pad:=' '||coalesce(v_norm,'')||' ';
  begin
    v_count:=coalesce((v_context->>'candidate_count')::integer,0);
  exception when others then
    v_count:=0;
  end;

  if v_count<2 then return false; end if;
  if position(' hoac ' in v_pad)>0 then return false; end if;

  return position(' va ' in v_pad)>0
      or position(' ca hai ' in v_pad)>0
      or position(' ca 2 ' in v_pad)>0
      or position(' deu ' in v_pad)>0
      or position('&' in coalesce(input_text,''))>0
      or position('+' in coalesce(input_text,''))>0
      or regexp_count(v_pad,' combo ')>=2;
end;
$function$;

create or replace function public.v8_sync_conversation_history_preflight(
  p_page_id text,
  p_sender_id text,
  p_conversation_id text,
  p_messages jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_customer_id uuid;
  v_inserted integer:=0;
  v_outbound integer:=0;
  v_inbound integer:=0;
begin
  if nullif(btrim(coalesce(p_page_id,'')),'') is null
     or nullif(btrim(coalesce(p_sender_id,'')),'') is null then
    return jsonb_build_object('ok',false,'reason','PAGE_OR_SENDER_MISSING');
  end if;

  insert into public.v8_customers(page_id,sender_id,last_seen_at,raw_profile,meta_conversation_id,meta_history_synced_at,history_sync_status,history_sync_error)
  values(p_page_id,p_sender_id,now(),jsonb_build_object('source','Meta preflight history'),p_conversation_id,now(),'synced',null)
  on conflict(page_id,sender_id) do update set
    last_seen_at=greatest(public.v8_customers.last_seen_at,excluded.last_seen_at),
    raw_profile=coalesce(public.v8_customers.raw_profile,'{}'::jsonb)||excluded.raw_profile,
    meta_conversation_id=coalesce(excluded.meta_conversation_id,public.v8_customers.meta_conversation_id),
    meta_history_synced_at=now(),history_sync_status='synced',history_sync_error=null
  returning id into v_customer_id;

  with src as (
    select x
    from jsonb_array_elements(coalesce(p_messages,'[]'::jsonb)) x
    where nullif(x->>'id','') is not null
  ), ins as (
    insert into public.v8_messages_raw(
      customer_id,page_id,sender_id,conversation_id,message_id,direction,
      actor_type,actor_name,source_system,is_automatic,actor_confidence,source_detail,
      message_text,attachments,raw_payload,sent_at
    )
    select
      v_customer_id,p_page_id,p_sender_id,coalesce(nullif(p_conversation_id,''),p_sender_id),
      x->>'id',
      case when x->'from'->>'id'=p_page_id then 'outbound' else 'inbound' end,
      case when x->'from'->>'id'=p_page_id then 'page_or_system' else 'customer' end,
      coalesce(nullif(x->'from'->>'name',''),case when x->'from'->>'id'=p_page_id then 'Page/nhân viên' else 'Khách hàng' end),
      case when x->'from'->>'id'=p_page_id then 'meta_page_history' else 'meta_customer_history' end,
      case when x->'from'->>'id'=p_page_id then null else false end,
      case when x->'from'->>'id'=p_page_id then 'history_page_origin' else 'history_customer' end,
      jsonb_build_object('classification',case when x->'from'->>'id'=p_page_id then 'page_history_preflight' else 'customer_history_preflight' end,'source','meta_conversations_api'),
      nullif(x->>'message',''),
      coalesce(x->'attachments'->'data',x->'attachments','[]'::jsonb),
      jsonb_build_object('source','meta_history_preflight')||x,
      coalesce((x->>'created_time')::timestamptz,now())
    from src
    on conflict(page_id,message_id) do nothing
    returning direction
  )
  select count(*),count(*) filter(where direction='outbound'),count(*) filter(where direction='inbound')
  into v_inserted,v_outbound,v_inbound from ins;

  return jsonb_build_object(
    'ok',true,'customer_id',v_customer_id,'inserted',v_inserted,
    'outbound_inserted',v_outbound,'inbound_inserted',v_inbound,
    'human_takeover_possible',v_outbound>0
  );
end;
$function$;

create or replace function public.v8_capture_multi_product_context()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_text text;
  v_groups jsonb;
  v_item jsonb;
  v_message_row_id uuid;
begin
  if new.status<>'done' then return new; end if;
  v_text:=coalesce(new.payload->>'message_text','');
  if not public.v8_is_explicit_multi_product(v_text) then return new; end if;

  v_groups:=coalesce(new.payload#>'{group_context,candidates}','[]'::jsonb);
  if jsonb_array_length(v_groups)<2 then return new; end if;

  update public.v8_conversation_states
  set metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
        'multi_product_groups',v_groups,
        'multi_product_message_id',new.message_id,
        'multi_product_detected_at',now()
      ),
      updated_at=now()
  where customer_id=new.customer_id
     or (page_id=new.page_id and sender_id=new.sender_id);

  select id into v_message_row_id
  from public.v8_messages_raw
  where page_id=new.page_id and message_id=new.message_id
  limit 1;

  for v_item in select value from jsonb_array_elements(v_groups)
  loop
    insert into public.v8_product_intents(
      customer_id,message_id,page_id,sender_id,product_key,product_name,
      intent_type,confidence,evidence,source
    )
    select new.customer_id,v_message_row_id,new.page_id,new.sender_id,
      v_item->>'group_key',v_item->>'group_name','multi_product_interest',0.95,
      v_text,'multi_product_rule'
    where nullif(v_item->>'group_key','') is not null
      and not exists(
        select 1 from public.v8_product_intents pi
        where pi.message_id=v_message_row_id
          and pi.product_key=v_item->>'group_key'
          and pi.source='multi_product_rule'
      );
  end loop;

  return new;
end;
$function$;

drop trigger if exists trg_v8_capture_multi_product_context on public.v8_processing_queue;
create trigger trg_v8_capture_multi_product_context
after insert or update of status,payload,product_key,catalog_key on public.v8_processing_queue
for each row execute function public.v8_capture_multi_product_context();

create or replace function public.v8_guard_reply_plan_context()
returns trigger
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  v_queue public.v8_processing_queue%rowtype;
  v_text text:='';
  v_groups jsonb:='[]'::jsonb;
  v_group_names text;
  v_has_contact boolean:=false;
  v_previous_id uuid;
  v_original_action text;
begin
  v_original_action:=new.action_type;

  if new.queue_id is not null then
    select * into v_queue from public.v8_processing_queue where id=new.queue_id;
    v_text:=coalesce(v_queue.payload->>'message_text','');
    v_groups:=coalesce(v_queue.payload#>'{group_context,candidates}','[]'::jsonb);
  end if;

  if public.v8_is_explicit_multi_product(v_text) and jsonb_array_length(v_groups)>=2 then
    select string_agg(coalesce(x->>'group_name',x->>'group_key'),' và '
                      order by coalesce((x->>'priority')::integer,999),x->>'group_name')
      into v_group_names
    from jsonb_array_elements(v_groups) x;

    select coalesce(c.phone is not null or c.zalo is not null,false)
      into v_has_contact
    from public.v8_customers c where c.id=new.customer_id;
    v_has_contact:=coalesce(v_has_contact,false) or coalesce((select s.has_phone from public.v8_conversation_states s where s.customer_id=new.customer_id),false);

    new.business_group_key:=null;
    new.intent_type:=coalesce(new.intent_type,'ask_info');
    new.should_ask_need:=false;
    new.should_request_phone:=not v_has_contact;
    new.should_handoff_sale:=v_has_contact;
    new.conversation_stage:=case when v_has_contact then 'handoff' else 'capture' end;
    new.action_type:=case when v_has_contact then 'handoff_multi_product' else 'capture_multi_product_contact' end;
    new.suggested_reply:=case when v_has_contact then
      'Dạ, em đã ghi nhận {salutation} quan tâm cả '||coalesce(v_group_names,'các nhóm sản phẩm')||'. Em chuyển Sale gửi đúng mẫu và báo giá từng nhóm ạ.'
    else
      'Dạ, em đã ghi nhận {salutation} quan tâm cả '||coalesce(v_group_names,'các nhóm sản phẩm')||'. {salutation} cho em xin số Zalo để em gửi đúng mẫu và báo giá từng nhóm ạ.'
    end;
    new.reason:=coalesce(new.reason,'{}'::jsonb)||jsonb_build_object(
      'multi_product',true,
      'multi_product_groups',v_groups,
      'original_action_type',v_original_action,
      'multi_product_policy','acknowledge_all_do_not_ask_again'
    );
  end if;

  if new.customer_id is not null
     and nullif(public.v8_reply_fingerprint(new.suggested_reply),'') is not null then
    select rp.id into v_previous_id
    from public.v8_reply_plans rp
    where rp.customer_id=new.customer_id
      and rp.id is distinct from new.id
      and rp.sent_at is not null
      and rp.sent_at>=now()-interval '30 minutes'
      and (
        public.v8_reply_fingerprint(rp.suggested_reply)=public.v8_reply_fingerprint(new.suggested_reply)
        or (new.action_type='ask_product_group' and rp.action_type='ask_product_group')
      )
    order by rp.sent_at desc
    limit 1;

    if v_previous_id is not null then
      new.send_eligible:=false;
      new.safety_status:='suppressed_duplicate_reply';
      new.blocked_reason:='duplicate_reply_within_30m';
      new.reason:=coalesce(new.reason,'{}'::jsonb)||jsonb_build_object(
        'duplicate_guard',true,'duplicate_of_reply_plan_id',v_previous_id,'duplicate_window_minutes',30
      );
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_v8_aa_guard_reply_plan_context on public.v8_reply_plans;
create trigger trg_v8_aa_guard_reply_plan_context
before insert or update of queue_id,customer_id,action_type,suggested_reply,send_eligible on public.v8_reply_plans
for each row execute function public.v8_guard_reply_plan_context();

create or replace function public.v8_guard_outbound_duplicate_text()
returns trigger
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  v_text text;
  v_duplicate boolean:=false;
begin
  if new.message_type<>'text' or new.status not in ('ready','sending') then return new; end if;
  v_text:=nullif(btrim(coalesce(new.payload->>'text','')),'');
  if v_text is null then return new; end if;

  select exists(
    select 1 from public.v8_messages_raw m
    where m.customer_id=new.customer_id
      and m.direction='outbound'
      and coalesce(m.source_system,'') in ('aiguka','aiguka_v8')
      and m.sent_at>=now()-interval '30 minutes'
      and public.v8_reply_fingerprint(m.message_text)=public.v8_reply_fingerprint(v_text)
  ) into v_duplicate;

  if v_duplicate then
    new.status:='cancelled';
    new.cancelled_at:=now();
    new.cancel_reason:='DUPLICATE_TEXT_WITHIN_30M';
    new.locked_at:=null;
    new.locked_by:=null;
    new.authorized_at:=null;
    new.authorized_by:=null;
    new.transport_confirmed_at:=null;
    new.transport_confirmed_by:=null;
    new.updated_at:=now();
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_v8_aa_guard_outbound_duplicate_text on public.v8_outbound_queue;
create trigger trg_v8_aa_guard_outbound_duplicate_text
before insert or update of status,payload on public.v8_outbound_queue
for each row execute function public.v8_guard_outbound_duplicate_text();

comment on function public.v8_sync_conversation_history_preflight(text,text,text,jsonb)
is 'Đồng bộ lịch sử Meta ngay trước lúc gửi để phát hiện Sale/Admin vừa trả lời và kích hoạt human takeover.';
comment on function public.v8_is_explicit_multi_product(text)
is 'Nhận diện khách chủ động quan tâm đồng thời từ hai nhóm sản phẩm trở lên; không coi từ hoặc là chọn cả hai.';
