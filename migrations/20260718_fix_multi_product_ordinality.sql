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
    select string_agg(coalesce(x.value->>'group_name',x.value->>'group_key'),' và ' order by x.ordinality)
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
