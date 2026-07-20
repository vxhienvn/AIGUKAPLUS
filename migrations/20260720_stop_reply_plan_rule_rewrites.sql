create or replace function public.v8_guard_reply_plan_context()
returns trigger
language plpgsql
security definer
set search_path to 'public','extensions'
as $$
declare
  v_queue public.v8_processing_queue%rowtype;
  v_text text:='';
  v_context jsonb:='{}'::jsonb;
  v_groups jsonb:='[]'::jsonb;
  v_previous_id uuid;
  v_advisories jsonb:='[]'::jsonb;
begin
  if new.queue_id is not null then
    select * into v_queue from public.v8_processing_queue where id=new.queue_id;
    v_text:=coalesce(v_queue.payload->>'message_text','');
    v_context:=coalesce(v_queue.payload->'group_context','{}'::jsonb);
    v_groups:=public.v8_compact_multi_product_candidates(v_text,v_context);
  end if;

  if public.v8_is_explicit_multi_product(v_text) and jsonb_array_length(v_groups)>=2 then
    v_advisories:=coalesce(new.reason->'rule_advisories','[]'::jsonb)||jsonb_build_array(jsonb_build_object(
      'source','multi_product_context_rule',
      'severity','info',
      'recommended_action','ai_consider_all_explicit_products',
      'groups',v_groups,
      'may_modify_ai_reply',false
    ));
    new.reason:=coalesce(new.reason,'{}'::jsonb)||jsonb_build_object(
      'multi_product',true,
      'multi_product_groups',v_groups,
      'rule_advisories',v_advisories
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
        'duplicate_guard',true,
        'duplicate_of_reply_plan_id',v_previous_id,
        'duplicate_window_minutes',30
      );
    end if;
  end if;
  return new;
end;
$$;