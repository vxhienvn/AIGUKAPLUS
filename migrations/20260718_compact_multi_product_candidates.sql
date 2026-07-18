create or replace function public.v8_compact_multi_product_candidates(input_text text,p_context jsonb)
returns jsonb
language sql
stable
security definer
set search_path to 'public','extensions'
as $function$
with inp as (
  select public.v8_normalize_detector_text(coalesce(input_text,'')) as normalized_input
), candidates as (
  select
    x.value as item,
    x.ordinality as ord,
    public.v8_normalize_detector_text(coalesce(x.value->>'matched_term','')) as normalized_term,
    coalesce((x.value->>'priority')::integer,999) as priority,
    x.value->>'group_key' as group_key
  from jsonb_array_elements(coalesce(p_context->'candidates','[]'::jsonb)) with ordinality x(value,ordinality)
), kept as (
  select c.*,
         coalesce(nullif(strpos(i.normalized_input,c.normalized_term),0),2147483647) as text_position
  from candidates c cross join inp i
  where nullif(c.group_key,'') is not null
    and not exists(
      select 1 from candidates longer
      where longer.group_key is distinct from c.group_key
        and length(longer.normalized_term)>length(c.normalized_term)
        and c.normalized_term<>''
        and strpos(longer.normalized_term,c.normalized_term)>0
    )
)
select coalesce(jsonb_agg(item order by text_position,priority,ord),'[]'::jsonb)
from kept;
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
  v_groups jsonb;
  v_count integer:=0;
begin
  v_pad:=' '||coalesce(v_norm,'')||' ';
  v_groups:=public.v8_compact_multi_product_candidates(input_text,v_context);
  v_count:=jsonb_array_length(v_groups);

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

create or replace function public.v8_capture_multi_product_context()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_text text;
  v_context jsonb;
  v_groups jsonb;
  v_item jsonb;
  v_message_row_id uuid;
begin
  if new.status<>'done' then return new; end if;
  v_text:=coalesce(new.payload->>'message_text','');
  if not public.v8_is_explicit_multi_product(v_text) then return new; end if;

  v_context:=coalesce(new.payload->'group_context','{}'::jsonb);
  v_groups:=public.v8_compact_multi_product_candidates(v_text,v_context);
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

create or replace function public.v8_guard_reply_plan_context()
returns trigger
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  v_queue public.v8_processing_queue%rowtype;
  v_text text:='';
  v_context jsonb:='{}'::jsonb;
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
    v_context:=coalesce(v_queue.payload->'group_context','{}'::jsonb);
    v_groups:=public.v8_compact_multi_product_candidates(v_text,v_context);
  end if;

  if public.v8_is_explicit_multi_product(v_text) and jsonb_array_length(v_groups)>=2 then
    select string_agg(coalesce(x->>'group_name',x->>'group_key'),' và ' order by x.ordinality)
      into v_group_names
    from jsonb_array_elements(v_groups) with ordinality x(value,ordinality);

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
      'Dạ, em đã ghi nhận {salutation} quan tâm cả '||coalesce(v_group_names,'các nhóm sản phẩm')||'. Cho em xin số Zalo để em gửi đúng mẫu và báo giá từng nhóm ạ.'
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
