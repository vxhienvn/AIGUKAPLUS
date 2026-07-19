-- Fix live Total Kho case at 15:15 on 2026-07-19.
-- Do not replay or requeue historical customer messages.

update public.v8_text_corrections
set is_active=false,
    note=concat_ws(' | ',nullif(note,''),'Disabled: generic sink phrase is ambiguous between bathroom lavabo and kitchen sink'),
    updated_at=now()
where normalized_wrong_text in ('chau rua','bon rua');

insert into public.v8_product_aliases(
  catalog_key,alias,normalized_alias,priority,confidence,source,is_active,updated_at
) values
  ('chau_voi_rua_bat','chậu rửa phòng bếp','chau rua phong bep',6,99,'core_fix_20260719',true,now()),
  ('chau_voi_rua_bat','chậu rửa bếp','chau rua bep',7,99,'core_fix_20260719',true,now()),
  ('chau_voi_rua_bat','bồn rửa phòng bếp','bon rua phong bep',8,98,'core_fix_20260719',true,now()),
  ('chau_voi_rua_bat','bồn rửa bếp','bon rua bep',9,98,'core_fix_20260719',true,now()),
  ('chau_voi_rua_bat','chậu inox một hố','chau inox mot ho',10,98,'core_fix_20260719',true,now())
on conflict(catalog_key,normalized_alias) do update set
  alias=excluded.alias,
  priority=least(public.v8_product_aliases.priority,excluded.priority),
  confidence=greatest(public.v8_product_aliases.confidence,excluded.confidence),
  source=excluded.source,
  is_active=true,
  updated_at=now();

insert into public.v8_intent_rules(
  intent_type,keyword,match_type,priority,lead_score_delta,is_active,note,updated_at
) values
  ('ask_sample','tham khảo mẫu','contains',4,20,true,'Real customer wording: request to view product samples',now()),
  ('ask_sample','tham khảo hình ảnh','contains',4,20,true,'Real customer wording: request product images',now()),
  ('ask_sample','tham khảo ảnh','contains',5,20,true,'Real customer wording: request product images',now()),
  ('ask_sample','tham khảo sản phẩm','contains',6,18,true,'Real customer wording: request product references',now())
on conflict(intent_type,keyword) do update set
  match_type=excluded.match_type,
  priority=least(public.v8_intent_rules.priority,excluded.priority),
  lead_score_delta=greatest(public.v8_intent_rules.lead_score_delta,excluded.lead_score_delta),
  is_active=true,
  note=excluded.note,
  updated_at=now();

create or replace function public.v8_infer_pending_sample_intent(
  p_page_id text,
  p_sender_id text,
  p_before timestamptz,
  p_current_intent text,
  p_current_catalog_key text,
  p_current_product_key text
)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  r record;
  v_resolved_intent text;
  v_rule record;
begin
  if coalesce(nullif(p_current_intent,''),'message')<>'message' then
    return '{}'::jsonb;
  end if;
  if coalesce(p_current_catalog_key,p_current_product_key) is null then
    return '{}'::jsonb;
  end if;

  for r in
    select m.message_id,m.message_text,m.sent_at,pq.intent_type
    from public.v8_messages_raw m
    left join lateral (
      select q.intent_type
      from public.v8_processing_queue q
      where q.page_id=m.page_id and q.message_id=m.message_id
      order by q.created_at desc
      limit 1
    ) pq on true
    where m.page_id=p_page_id
      and m.sender_id=p_sender_id
      and m.direction='inbound'
      and m.sent_at<coalesce(p_before,now())
      and m.sent_at>=coalesce(p_before,now())-interval '5 minutes'
      and nullif(btrim(coalesce(m.message_text,'')),'') is not null
    order by m.sent_at desc,m.created_at desc
    limit 10
  loop
    v_resolved_intent:=coalesce(nullif(r.intent_type,''),'message');

    if v_resolved_intent='message' and public.v8_extract_vietnam_phone(r.message_text) is not null then
      v_resolved_intent:='provide_contact';
    elsif v_resolved_intent='message' then
      v_rule:=null;
      select * into v_rule from public.v8_detect_intent_rule(r.message_text) limit 1;
      v_resolved_intent:=coalesce(nullif(v_rule.intent_type,''),'message');
    end if;

    if v_resolved_intent='message' then continue; end if;

    if v_resolved_intent='ask_sample' then
      return jsonb_build_object(
        'intent_type','ask_sample',
        'context_type','sample_request_product_clarification',
        'previous_message_id',r.message_id,
        'previous_message',r.message_text,
        'previous_message_at',r.sent_at,
        'context_applied',true
      );
    end if;
    return '{}'::jsonb;
  end loop;

  return '{}'::jsonb;
end;
$function$;

create or replace function public.v8_queue_direct_context_postprocess()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_text text:=coalesce(new.payload->>'message_text','');
  v_prev text;
  v_prev_norm text;
  v_event_time timestamptz:=coalesce(nullif(new.payload->>'event_time','')::timestamptz,new.created_at,now());
  v_direct jsonb:=public.v8_infer_direct_text_intent(v_text);
  v_pending_sample jsonb:='{}'::jsonb;
  v_inferred text:=nullif(v_direct->>'intent_type','');
  v_context text:=nullif(v_direct->>'context_type','');
begin
  if coalesce(nullif(new.intent_type,''),'message')<>'message' then return new; end if;

  if v_inferred is null then
    v_pending_sample:=public.v8_infer_pending_sample_intent(
      new.page_id,new.sender_id,v_event_time,new.intent_type,new.catalog_key,new.product_key
    );
    v_inferred:=nullif(v_pending_sample->>'intent_type','');
    v_context:=nullif(v_pending_sample->>'context_type','');
    v_prev:=v_pending_sample->>'previous_message';
  end if;

  if v_inferred is null then
    select m.message_text into v_prev
    from public.v8_messages_raw m
    where m.page_id=new.page_id and m.sender_id=new.sender_id
      and m.direction='inbound'
      and nullif(btrim(coalesce(m.message_text,'')),'') is not null
      and m.sent_at<v_event_time
    order by m.sent_at desc,m.created_at desc
    limit 1;
    v_prev_norm:=public.v8_normalize_detector_text(v_prev);
    if coalesce(v_prev_norm,'') ~ '(o dau|dia chi|xem tai dau|xem o dau|kho.*o dau|cua hang.*o dau)'
       and public.v8_is_likely_location_text(v_text) then
      v_inferred:='provide_location';
      v_context:='location_after_address_question';
    end if;
  end if;

  if v_inferred is not null then
    new.intent_type:=v_inferred;
    new.validation_status:='passed';
    new.validation_code:='VALID';
    new.payload:=jsonb_set(coalesce(new.payload,'{}'::jsonb),'{contextual_intent}',jsonb_build_object(
      'intent_type',v_inferred,
      'context_applied',true,
      'context_type',v_context,
      'previous_message',v_prev,
      'previous_message_id',v_pending_sample->>'previous_message_id',
      'previous_message_at',v_pending_sample->>'previous_message_at'
    ),true);
    new.payload:=jsonb_set(new.payload,'{validation}',jsonb_build_object(
      'code','VALID','status','passed','severity','info',
      'should_plan_reply',v_inferred<>'decline_interest',
      'should_plan_slide',v_inferred='ask_sample',
      'details',jsonb_build_object('context_postprocess',v_context)
    ),true);
  end if;
  return new;
end;
$function$;

comment on function public.v8_infer_pending_sample_intent(text,text,timestamptz,text,text,text)
is 'Carries ask_sample across short product-clarification turns. Contact, decline or another explicit intent closes the pending request.';
