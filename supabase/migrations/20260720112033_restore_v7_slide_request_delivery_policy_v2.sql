-- Restore the V7 media rule for the Total Kho SUPPORT page.
--
-- A customer who explicitly asks for product images may receive the mapped
-- slide even when Sale or AIcake has already sent text. AIGUKA still does not
-- send general text on this Page. Delivery stops when the customer has already
-- provided contact details, explicitly declines, or asks for a different
-- product scope after the original request.

insert into public.v8_config_hub(key,scope,value,is_active,updated_at)
values(
  'v7_slide_request_policy',
  'page:104810069068200',
  jsonb_build_object(
    'enabled',true,
    'page_id','104810069068200',
    'allow_after_external_reply',true,
    'allow_after_non_terminal_customer_message',true,
    'skip_when_contact_provided',true,
    'skip_when_customer_declines',true,
    'skip_when_new_sample_scope_differs',true,
    'aiguka_general_text_enabled',false,
    'text_reply_owner','aicake_or_sale',
    'contact_hint','Đây là một vài mẫu bán chạy tháng qua ạ. Anh/chị kết nối qua SĐT/Zalo, em gửi thêm nhiều mẫu khác từ cơ bản đến cao cấp.',
    'version','v7_slide_request_delivery_v1'
  ),
  true,
  now()
)
on conflict(key,scope) do update set
  value=excluded.value,
  is_active=true,
  updated_at=now();

create or replace function public.v8_customer_has_contact(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select
    exists(
      select 1
      from public.v8_customers c
      where c.id=p_customer_id
        and (nullif(btrim(c.phone),'') is not null or nullif(btrim(c.zalo),'') is not null)
    )
    or exists(
      select 1
      from public.v8_conversation_states s
      where s.customer_id=p_customer_id and coalesce(s.has_phone,false)
    )
    or exists(
      select 1
      from public.v8_lead_events le
      where le.customer_id=p_customer_id
        and (
          nullif(btrim(le.phone),'') is not null
          or nullif(btrim(le.zalo),'') is not null
          or le.event_type in ('phone_detected','zalo_detected','provide_contact')
        )
    )
    or exists(
      select 1
      from public.v8_messages_raw m
      where m.customer_id=p_customer_id
        and m.direction='inbound'
        and public.v8_extract_vietnam_phone(m.message_text) is not null
    );
$function$;

comment on function public.v8_customer_has_contact(uuid)
is 'Authoritative contact lock used by V7 slide delivery. Includes customer/state/lead evidence and newly inserted inbound phone messages.';

create or replace function public.v8_v7_slide_request_policy(p_slide_log_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  sl public.v8_slide_logs%rowtype;
  src public.v8_messages_raw%rowtype;
  source_queue public.v8_processing_queue%rowtype;
  v_policy record;
  v_cfg jsonb:='{}'::jsonb;
  v_enabled boolean:=false;
  v_support_slide_only boolean:=false;
  v_intent text;
  v_scope text;
  v_catalog_scope text;
  v_group_scope text;
  v_ai_decision_id uuid;
  v_has_contact boolean:=false;
  v_customer_declined boolean:=false;
  v_newer_scope_conflict boolean:=false;
  v_newer record;
  v_newer_intent text;
  v_newer_scope text;
  v_newer_catalog text;
  v_newer_group text;
  v_newer_group_context jsonb;
  v_newer_text text;
  v_blocked_reason text;
  v_protected boolean:=false;
begin
  select * into sl from public.v8_slide_logs where id=p_slide_log_id;
  if sl.id is null then
    return jsonb_build_object(
      'protected',false,'allow_delivery',false,'blocked_reason','slide_log_not_found',
      'version','v7_slide_request_delivery_v1'
    );
  end if;

  select * into src from public.v8_messages_raw where id=sl.message_id;

  begin
    if nullif(sl.reason->>'queue_id','') is not null then
      select * into source_queue
      from public.v8_processing_queue
      where id=(sl.reason->>'queue_id')::uuid;
    end if;
  exception when invalid_text_representation then
    null;
  end;

  if source_queue.id is null and src.id is not null then
    select * into source_queue
    from public.v8_processing_queue q
    where q.page_id=src.page_id and q.message_id=src.message_id
    order by q.created_at desc
    limit 1;
  end if;

  v_intent:=coalesce(nullif(source_queue.intent_type,''),nullif(sl.reason->>'intent_type',''));
  if v_intent is null and nullif(sl.reason->>'ai_decision_id','') is not null then
    begin
      v_ai_decision_id:=(sl.reason->>'ai_decision_id')::uuid;
      select d.intent_type into v_intent from public.v8_ai_decisions d where d.id=v_ai_decision_id;
    exception when invalid_text_representation then
      v_intent:=null;
    end;
  end if;

  v_catalog_scope:=coalesce(nullif(source_queue.catalog_key,''),nullif(sl.catalog_key,''));
  v_group_scope:=coalesce(
    nullif(source_queue.payload#>>'{mapping_resolution,group_key}',''),
    nullif(source_queue.product_key,''),
    nullif(sl.product_key,'')
  );
  if v_group_scope is null and v_catalog_scope is not null then
    select r.group_key into v_group_scope
    from public.v8_resolve_business_group(v_catalog_scope) r
    limit 1;
  end if;
  v_scope:=coalesce(v_catalog_scope,v_group_scope);

  select value into v_cfg
  from public.v8_config_hub
  where key='v7_slide_request_policy'
    and scope='page:'||sl.page_id
    and is_active
  order by updated_at desc
  limit 1;
  v_enabled:=coalesce((v_cfg->>'enabled')::boolean,false);

  select * into v_policy from public.v8_resolve_runtime_policy(sl.page_id) limit 1;
  v_support_slide_only:=
    coalesce(v_policy.page_mode,'')='SUPPORT'
    and coalesce((v_policy.policy_source->>'support_slide_only')::boolean,false)
    and coalesce(v_policy.can_send_image,false)
    and not coalesce(v_policy.can_send_text,false);

  v_protected:=v_enabled and v_support_slide_only and v_intent='ask_sample';
  v_has_contact:=public.v8_customer_has_contact(sl.customer_id);

  if v_protected and src.id is not null then
    for v_newer in
      select
        m.id,m.message_text,m.sent_at,
        q.intent_type,q.catalog_key,q.product_key,q.group_key
      from public.v8_messages_raw m
      left join lateral (
        select
          pq.intent_type,pq.catalog_key,pq.product_key,
          nullif(pq.payload#>>'{mapping_resolution,group_key}','') as group_key
        from public.v8_processing_queue pq
        where pq.page_id=m.page_id and pq.message_id=m.message_id
        order by pq.created_at desc
        limit 1
      ) q on true
      where m.customer_id=sl.customer_id
        and m.direction='inbound'
        and m.sent_at>src.sent_at
      order by m.sent_at,m.created_at
    loop
      v_newer_intent:=nullif(v_newer.intent_type,'');
      if v_newer_intent is null then
        select r.intent_type into v_newer_intent
        from public.v8_detect_intent_rule(v_newer.message_text) r
        limit 1;
      end if;

      v_newer_text:=lower(public.unaccent(coalesce(v_newer.message_text,'')));
      if v_newer_intent in ('decline','decline_contact','decline_interest')
         or v_newer_text ~ '(^|[[:space:][:punct:]])(khong can|khong gui|dung gui|khoi gui|thoi khong can)[[:space:]]+(them[[:space:]]+)?(anh|hinh|mau|slide)([[:space:][:punct:]]|$)' then
        v_customer_declined:=true;
      end if;

      v_newer_catalog:=nullif(v_newer.catalog_key,'');
      v_newer_group:=coalesce(nullif(v_newer.group_key,''),nullif(v_newer.product_key,''));
      if v_newer_catalog is null then
        select d.catalog_key into v_newer_catalog
        from public.v8_detect_catalog_smart(v_newer.message_text) d
        limit 1;
      end if;
      if v_newer_group is null and v_newer_catalog is not null then
        select r.group_key into v_newer_group
        from public.v8_resolve_business_group(v_newer_catalog) r
        limit 1;
      end if;
      if v_newer_group is null then
        v_newer_group_context:=public.v8_resolve_group_context(v_newer.message_text);
        if v_newer_group_context->>'status'='resolved' then
          v_newer_group:=nullif(v_newer_group_context#>>'{group,group_key}','');
        end if;
      end if;
      v_newer_scope:=coalesce(v_newer_catalog,v_newer_group);
      if v_newer_intent='ask_sample'
         and (
           (v_catalog_scope is not null and v_newer_catalog is not null
             and v_newer_catalog is distinct from v_catalog_scope)
           or
           (v_group_scope is not null and v_newer_group is not null
             and v_newer_group is distinct from v_group_scope)
         ) then
        v_newer_scope_conflict:=true;
      end if;
    end loop;
  end if;

  v_blocked_reason:=case
    when not v_protected then null
    when v_has_contact then 'customer_contact_provided'
    when v_customer_declined then 'customer_declined_after_sample_request'
    when v_newer_scope_conflict then 'newer_sample_scope_requested'
    else null
  end;

  return jsonb_build_object(
    'protected',v_protected,
    'allow_delivery',v_protected and v_blocked_reason is null,
    'blocked_reason',v_blocked_reason,
    'has_contact',v_has_contact,
    'customer_declined',v_customer_declined,
    'newer_scope_conflict',v_newer_scope_conflict,
    'intent_type',v_intent,
    'source_queue_id',source_queue.id,
    'source_scope',v_scope,
    'support_slide_only',v_support_slide_only,
    'text_reply_owner',coalesce(v_cfg->>'text_reply_owner','aicake_or_sale'),
    'version','v7_slide_request_delivery_v1'
  );
end;
$function$;

comment on function public.v8_v7_slide_request_policy(uuid)
is 'Allows a mapped ask_sample slide on configured SUPPORT slide-only Pages despite Sale/AIcake text. Contact, explicit decline, or a newer different sample scope still blocks.';

create or replace function public.v8_v7_slide_outbound_policy(p_outbound_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  q public.v8_outbound_queue%rowtype;
  v_result jsonb;
begin
  select * into q from public.v8_outbound_queue where id=p_outbound_id;
  if q.id is null or q.message_type<>'image' or q.slide_log_id is null then
    return jsonb_build_object(
      'protected',false,'allow_delivery',false,
      'blocked_reason',case when q.id is null then 'outbound_not_found' else null end,
      'version','v7_slide_request_delivery_v1'
    );
  end if;
  v_result:=public.v8_v7_slide_request_policy(q.slide_log_id);
  return v_result||jsonb_build_object('outbound_id',q.id,'message_type',q.message_type);
end;
$function$;

comment on function public.v8_v7_slide_outbound_policy(uuid)
is 'Outbound wrapper for the V7 SUPPORT slide exception.';

create or replace function public.v8_cancel_outbound_on_conversation_activity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.customer_id is null then return new; end if;

  if new.direction='inbound' then
    update public.v8_outbound_queue oq
    set status='cancelled',
        cancelled_at=now(),
        cancel_reason=case
          when public.v8_extract_vietnam_phone(new.message_text) is not null
            then 'customer_contact_provided'
          when oq.slide_log_id is not null then coalesce(
            nullif(public.v8_v7_slide_outbound_policy(oq.id)->>'blocked_reason',''),
            'newer_customer_message'
          )
          else 'newer_customer_message'
        end,
        updated_at=now()
    where oq.customer_id=new.customer_id
      and oq.status in ('planned','ready','sending')
      and (
        exists(
          select 1
          from public.v8_reply_plans rp
          join public.v8_messages_raw src on src.page_id=rp.page_id and src.message_id=rp.message_id
          where rp.id=oq.reply_plan_id and src.sent_at<new.sent_at
        )
        or exists(
          select 1
          from public.v8_slide_logs sl
          join public.v8_messages_raw src on src.id=sl.message_id
          where sl.id=oq.slide_log_id and src.sent_at<new.sent_at
        )
      )
      and (
        public.v8_extract_vietnam_phone(new.message_text) is not null
        or oq.slide_log_id is null
        or not coalesce((public.v8_v7_slide_outbound_policy(oq.id)->>'allow_delivery')::boolean,false)
      );
  elsif new.direction='outbound'
    and public.v8_is_actionable_external_outbound(
      new.source_system,new.message_text,new.attachments,new.is_automatic,new.actor_type,new.source_detail
    ) then
    update public.v8_outbound_queue oq
    set status='cancelled',
        cancelled_at=now(),
        cancel_reason=case
          when oq.slide_log_id is not null then coalesce(
            nullif(public.v8_v7_slide_outbound_policy(oq.id)->>'blocked_reason',''),
            'external_responder_replied'
          )
          else 'external_responder_replied'
        end,
        updated_at=now()
    where oq.customer_id=new.customer_id
      and oq.status in ('planned','ready','sending')
      and (
        exists(
          select 1
          from public.v8_reply_plans rp
          join public.v8_messages_raw src on src.page_id=rp.page_id and src.message_id=rp.message_id
          where rp.id=oq.reply_plan_id and src.sent_at<=new.sent_at
        )
        or exists(
          select 1
          from public.v8_slide_logs sl
          join public.v8_messages_raw src on src.id=sl.message_id
          where sl.id=oq.slide_log_id and src.sent_at<=new.sent_at
        )
      )
      and (
        oq.slide_log_id is null
        or not coalesce((public.v8_v7_slide_outbound_policy(oq.id)->>'allow_delivery')::boolean,false)
      );
  end if;

  return new;
end;
$function$;

create or replace function public.v8_reconcile_reply_plans_for_message(p_message_row_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  m public.v8_messages_raw%rowtype;
  v_plans integer:=0;
  v_suppressed_marked_old integer:=0;
  v_outbound integer:=0;
  v_slides integer:=0;
begin
  select * into m from public.v8_messages_raw where id=p_message_row_id;
  if m.id is null then return jsonb_build_object('ok',false,'error','message_not_found'); end if;

  if m.direction='outbound'
     and public.v8_is_actionable_external_outbound(
       m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail
     ) then
    with affected as (
      select rp.id
      from public.v8_reply_plans rp
      join public.v8_messages_raw src on src.page_id=rp.page_id and src.message_id=rp.message_id
      where rp.customer_id=m.customer_id
        and src.direction='inbound'
        and src.sent_at<=m.sent_at
        and coalesce(rp.dispatch_status,'not_staged')<>'sent'
        and rp.safety_status not like 'suppressed%'
        and not exists(
          select 1 from public.v8_messages_raw ni
          where ni.customer_id=m.customer_id and ni.direction='inbound'
            and ni.sent_at>src.sent_at and ni.sent_at<m.sent_at
        )
    )
    update public.v8_reply_plans rp
    set send_eligible=false,
        safety_status='suppressed_external_reply',
        blocked_reason='external_responder_replied',
        action_type='already_answered_external',
        suggested_reply='',
        reason=coalesce(rp.reason,'{}'::jsonb)||jsonb_build_object(
          'reconciled_after_external_activity',true,
          'external_message_id',m.message_id,
          'external_sent_at',m.sent_at,
          'external_actor',m.actor_name,
          'external_source',m.source_system
        ),
        dispatch_status=case when dispatch_status='sent' then dispatch_status else 'cancelled' end
    from affected a
    where rp.id=a.id;
    get diagnostics v_plans=row_count;

    update public.v8_outbound_queue oq
    set status='cancelled',
        cancelled_at=now(),
        cancel_reason=case
          when oq.slide_log_id is not null then coalesce(
            nullif(public.v8_v7_slide_outbound_policy(oq.id)->>'blocked_reason',''),
            'external_responder_replied'
          )
          else 'external_responder_replied'
        end,
        updated_at=now()
    where oq.customer_id=m.customer_id
      and oq.status in ('planned','ready','sending')
      and (
        exists(
          select 1 from public.v8_reply_plans rp
          join public.v8_messages_raw src on src.page_id=rp.page_id and src.message_id=rp.message_id
          where rp.id=oq.reply_plan_id and src.sent_at<=m.sent_at
        )
        or exists(
          select 1 from public.v8_slide_logs sl
          join public.v8_messages_raw src on src.id=sl.message_id
          where sl.id=oq.slide_log_id and src.sent_at<=m.sent_at
        )
      )
      and (
        oq.slide_log_id is null
        or not coalesce((public.v8_v7_slide_outbound_policy(oq.id)->>'allow_delivery')::boolean,false)
      );
    get diagnostics v_outbound=row_count;

    update public.v8_slide_logs sl
    set send_status='cancelled',
        decision_status='cancelled',
        safety_status=case public.v8_v7_slide_request_policy(sl.id)->>'blocked_reason'
          when 'customer_contact_provided' then 'suppressed_contact_lock'
          when 'customer_declined_after_sample_request' then 'suppressed_customer_decline'
          when 'newer_sample_scope_requested' then 'suppressed_superseded'
          else 'suppressed_external_reply'
        end,
        reason=coalesce(sl.reason,'{}'::jsonb)||jsonb_build_object(
          'reconciled_after_external_activity',true,
          'external_message_id',m.message_id,
          'external_sent_at',m.sent_at,
          'v7_slide_policy',public.v8_v7_slide_request_policy(sl.id)
        )
    where sl.customer_id=m.customer_id
      and sl.sent_at is null
      and sl.send_status in ('planned','queued')
      and exists(
        select 1
        from public.v8_messages_raw src
        where src.id=sl.message_id and src.direction='inbound' and src.sent_at<=m.sent_at
          and not exists(
            select 1 from public.v8_messages_raw ni
            where ni.customer_id=m.customer_id and ni.direction='inbound'
              and ni.sent_at>src.sent_at and ni.sent_at<m.sent_at
          )
      )
      and (
        not coalesce((public.v8_v7_slide_request_policy(sl.id)->>'allow_delivery')::boolean,false)
      );
    get diagnostics v_slides=row_count;

  elsif m.direction='inbound' then
    update public.v8_reply_plans rp
    set send_eligible=false,
        safety_status='suppressed_superseded',
        blocked_reason='later_customer_message_exists',
        action_type='superseded_by_later_customer_message',
        suggested_reply='',
        reason=coalesce(rp.reason,'{}'::jsonb)||jsonb_build_object(
          'reconciled_after_new_customer_message',true,
          'new_message_id',m.message_id,
          'new_message_sent_at',m.sent_at
        ),
        is_latest_customer_turn=false,
        dispatch_status=case when dispatch_status='sent' then dispatch_status else 'cancelled' end
    from public.v8_messages_raw src
    where rp.customer_id=m.customer_id
      and src.page_id=rp.page_id and src.message_id=rp.message_id and src.direction='inbound'
      and src.sent_at<m.sent_at
      and coalesce(rp.dispatch_status,'not_staged')<>'sent'
      and rp.safety_status not like 'suppressed%';
    get diagnostics v_plans=row_count;

    update public.v8_reply_plans rp
    set is_latest_customer_turn=false,
        reason=coalesce(rp.reason,'{}'::jsonb)||jsonb_build_object(
          'later_customer_message_exists',true,
          'new_message_id',m.message_id,
          'new_message_sent_at',m.sent_at
        )
    from public.v8_messages_raw src
    where rp.customer_id=m.customer_id
      and src.page_id=rp.page_id and src.message_id=rp.message_id and src.direction='inbound'
      and src.sent_at<m.sent_at
      and coalesce(rp.dispatch_status,'not_staged')<>'sent'
      and rp.safety_status like 'suppressed%'
      and coalesce(rp.is_latest_customer_turn,true)=true;
    get diagnostics v_suppressed_marked_old=row_count;

    update public.v8_outbound_queue oq
    set status='cancelled',
        cancelled_at=now(),
        cancel_reason=case
          when public.v8_extract_vietnam_phone(m.message_text) is not null
            then 'customer_contact_provided'
          when oq.slide_log_id is not null then coalesce(
            nullif(public.v8_v7_slide_outbound_policy(oq.id)->>'blocked_reason',''),
            'newer_customer_message'
          )
          else 'newer_customer_message'
        end,
        updated_at=now()
    where oq.customer_id=m.customer_id
      and oq.status in ('planned','ready','sending')
      and (
        exists(
          select 1 from public.v8_reply_plans rp
          join public.v8_messages_raw src on src.page_id=rp.page_id and src.message_id=rp.message_id
          where rp.id=oq.reply_plan_id and src.sent_at<m.sent_at
        )
        or exists(
          select 1 from public.v8_slide_logs sl
          join public.v8_messages_raw src on src.id=sl.message_id
          where sl.id=oq.slide_log_id and src.sent_at<m.sent_at
        )
      )
      and (
        public.v8_extract_vietnam_phone(m.message_text) is not null
        or oq.slide_log_id is null
        or not coalesce((public.v8_v7_slide_outbound_policy(oq.id)->>'allow_delivery')::boolean,false)
      );
    get diagnostics v_outbound=row_count;

    update public.v8_slide_logs sl
    set send_status='cancelled',
        decision_status='cancelled',
        safety_status=case public.v8_v7_slide_request_policy(sl.id)->>'blocked_reason'
          when 'customer_contact_provided' then 'suppressed_contact_lock'
          when 'customer_declined_after_sample_request' then 'suppressed_customer_decline'
          when 'newer_sample_scope_requested' then 'suppressed_superseded'
          else 'suppressed_superseded'
        end,
        reason=coalesce(sl.reason,'{}'::jsonb)||jsonb_build_object(
          'reconciled_after_new_customer_message',true,
          'new_message_id',m.message_id,
          'new_message_sent_at',m.sent_at,
          'v7_slide_policy',public.v8_v7_slide_request_policy(sl.id)
        )
    from public.v8_messages_raw src
    where sl.customer_id=m.customer_id
      and src.id=sl.message_id
      and src.direction='inbound'
      and src.sent_at<m.sent_at
      and sl.sent_at is null
      and sl.send_status in ('planned','queued')
      and (
        public.v8_extract_vietnam_phone(m.message_text) is not null
        or not coalesce((public.v8_v7_slide_request_policy(sl.id)->>'allow_delivery')::boolean,false)
      );
    get diagnostics v_slides=row_count;
  end if;

  return jsonb_build_object(
    'ok',true,'message_id',m.message_id,
    'reply_plans_reconciled',v_plans,
    'suppressed_plans_marked_old',v_suppressed_marked_old,
    'outbound_cancelled',v_outbound,
    'slides_cancelled',v_slides,
    'v7_slide_request_policy_preserved',true
  );
end;
$function$;

-- Preserve the current Final Gate and alter only the three conversation
-- suppression checks for an eligible V7 SUPPORT slide.
do $migration$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef('public.v8_evaluate_outbound_gate(uuid)'::regprocedure)
    into v_definition;

  if position('v_v7_slide_allowed' in v_definition)>0 then return; end if;

  v_old:=$old$
  v_price jsonb;
begin
$old$;
  v_new:=$new$
  v_price jsonb;
  v_v7_slide jsonb:='{}'::jsonb;
  v_v7_slide_protected boolean:=false;
  v_v7_slide_allowed boolean:=false;
begin
$new$;
  if position(v_old in v_definition)=0 then raise exception 'V7_GATE_DECLARATION_ANCHOR_NOT_FOUND'; end if;
  v_definition:=replace(v_definition,v_old,v_new);

  v_old:=$old$
  if q.attempts>=q.max_attempts then return query select false,'MAX_ATTEMPTS_REACHED',jsonb_build_object('attempts',q.attempts,'max_attempts',q.max_attempts); return; end if;
$old$;
  v_new:=$new$
  if q.attempts>=q.max_attempts then return query select false,'MAX_ATTEMPTS_REACHED',jsonb_build_object('attempts',q.attempts,'max_attempts',q.max_attempts); return; end if;

  v_v7_slide:=public.v8_v7_slide_outbound_policy(q.id);
  v_v7_slide_protected:=coalesce((v_v7_slide->>'protected')::boolean,false);
  v_v7_slide_allowed:=coalesce((v_v7_slide->>'allow_delivery')::boolean,false);
  if v_v7_slide_protected and not v_v7_slide_allowed then
    return query select false,upper(coalesce(v_v7_slide->>'blocked_reason','V7_SLIDE_POLICY_BLOCKED')),v_v7_slide;
    return;
  end if;
$new$;
  if position(v_old in v_definition)=0 then raise exception 'V7_GATE_SETUP_ANCHOR_NOT_FOUND'; end if;
  v_definition:=replace(v_definition,v_old,v_new);

  v_old:=$old$
  if s.manual_pause_until>now() then return query select false,'HUMAN_PAUSE_ACTIVE',jsonb_build_object('pause_until',s.manual_pause_until,'last_actor',s.last_outbound_actor); return; end if;
  if s.automation_pause_until>now() then return query select false,'AUTOMATION_PAUSE_ACTIVE',jsonb_build_object('pause_until',s.automation_pause_until,'source',s.last_automation_source); return; end if;
$old$;
  v_new:=$new$
  if not v_v7_slide_allowed and s.manual_pause_until>now() then return query select false,'HUMAN_PAUSE_ACTIVE',jsonb_build_object('pause_until',s.manual_pause_until,'last_actor',s.last_outbound_actor); return; end if;
  if not v_v7_slide_allowed and s.automation_pause_until>now() then return query select false,'AUTOMATION_PAUSE_ACTIVE',jsonb_build_object('pause_until',s.automation_pause_until,'source',s.last_automation_source); return; end if;
$new$;
  if position(v_old in v_definition)=0 then raise exception 'V7_GATE_PAUSE_ANCHOR_NOT_FOUND'; end if;
  v_definition:=replace(v_definition,v_old,v_new);

  v_old:=$old$
  if exists(select 1 from public.v8_messages_raw m where m.customer_id=q.customer_id and m.direction='inbound' and m.sent_at>v_source_at) then return query select false,'NEWER_CUSTOMER_MESSAGE','{}'::jsonb; return; end if;
$old$;
  v_new:=$new$
  if not v_v7_slide_allowed and exists(select 1 from public.v8_messages_raw m where m.customer_id=q.customer_id and m.direction='inbound' and m.sent_at>v_source_at) then return query select false,'NEWER_CUSTOMER_MESSAGE','{}'::jsonb; return; end if;
$new$;
  if position(v_old in v_definition)=0 then raise exception 'V7_GATE_NEWER_MESSAGE_ANCHOR_NOT_FOUND'; end if;
  v_definition:=replace(v_definition,v_old,v_new);

  v_old:=$old$
  if exists(select 1 from public.v8_messages_raw m where m.customer_id=q.customer_id and m.direction='outbound' and m.sent_at>=v_external_check_after and public.v8_is_actionable_external_outbound(m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail)) then return query select false,'EXTERNAL_RESPONDER_REPLIED','{}'::jsonb; return; end if;
$old$;
  v_new:=$new$
  if not v_v7_slide_allowed and exists(select 1 from public.v8_messages_raw m where m.customer_id=q.customer_id and m.direction='outbound' and m.sent_at>=v_external_check_after and public.v8_is_actionable_external_outbound(m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail)) then return query select false,'EXTERNAL_RESPONDER_REPLIED','{}'::jsonb; return; end if;
$new$;
  if position(v_old in v_definition)=0 then raise exception 'V7_GATE_EXTERNAL_REPLY_ANCHOR_NOT_FOUND'; end if;
  v_definition:=replace(v_definition,v_old,v_new);

  execute v_definition;
end;
$migration$;

-- Do not create media after contact was already captured. This is evaluated
-- before asset selection and before any outbound row can be staged.
do $migration$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef('public.v8_plan_slides_for_queue(uuid)'::regprocedure)
    into v_definition;

  if position('customer_contact_provided' in v_definition)>0 then return; end if;

  v_old:=$old$
  elsif q.validation_status<>'passed' then
    v_result:=jsonb_build_object('status','blocked_by_validation','validation_status',q.validation_status,'validation_code',q.validation_code,'planned',0);
$old$;
  v_new:=$new$
  elsif q.validation_status<>'passed' then
    v_result:=jsonb_build_object('status','blocked_by_validation','validation_status',q.validation_status,'validation_code',q.validation_code,'planned',0);
  elsif public.v8_customer_has_contact(q.customer_id) then
    v_result:=jsonb_build_object('status','customer_contact_provided','planned',0,'contact_lock',true);
$new$;
  if position(v_old in v_definition)=0 then raise exception 'V7_SLIDE_PLANNER_CONTACT_ANCHOR_NOT_FOUND'; end if;
  v_definition:=replace(v_definition,v_old,v_new);
  execute v_definition;
end;
$migration$;

create or replace function public.v8_sync_source_status_from_outbound()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_safety text;
begin
  if new.status is not distinct from old.status then return new; end if;

  if new.status='cancelled' then
    v_safety:=case lower(coalesce(new.cancel_reason,''))
      when 'external_responder_replied' then 'suppressed_external_reply'
      when 'newer_customer_message' then 'suppressed_superseded'
      when 'customer_contact_provided' then 'suppressed_contact_lock'
      when 'customer_declined_after_sample_request' then 'suppressed_customer_decline'
      when 'newer_sample_scope_requested' then 'suppressed_superseded'
      else 'cancelled_outbound'
    end;

    if new.slide_log_id is not null then
      update public.v8_slide_logs
      set send_status='cancelled',
          decision_status='cancelled',
          safety_status=v_safety,
          send_error=coalesce(send_error,new.cancel_reason),
          reason=coalesce(reason,'{}'::jsonb)||jsonb_build_object(
            'outbound_status_synced',true,
            'outbound_id',new.id,
            'cancel_reason',new.cancel_reason,
            'cancelled_at',coalesce(new.cancelled_at,now()),
            'v7_slide_policy',public.v8_v7_slide_outbound_policy(new.id)
          )
      where id=new.slide_log_id and sent_at is null and send_status in ('planned','queued');
    end if;

    if new.reply_plan_id is not null then
      update public.v8_reply_plans
      set send_eligible=false,
          dispatch_status='cancelled',
          blocked_reason=coalesce(blocked_reason,new.cancel_reason),
          safety_status=case
            when safety_status like 'suppressed%' then safety_status
            else v_safety
          end,
          reason=coalesce(reason,'{}'::jsonb)||jsonb_build_object(
            'outbound_status_synced',true,
            'outbound_id',new.id,
            'cancel_reason',new.cancel_reason,
            'cancelled_at',coalesce(new.cancelled_at,now())
          )
      where id=new.reply_plan_id and coalesce(dispatch_status,'not_staged')<>'sent';
    end if;

    if new.comment_event_id is not null then
      update public.v8_comment_events
      set private_reply_status='cancelled',
          classifier_reason=coalesce(classifier_reason,'{}'::jsonb)||jsonb_build_object(
            'outbound_status_synced',true,
            'outbound_id',new.id,
            'cancel_reason',new.cancel_reason,
            'cancelled_at',coalesce(new.cancelled_at,now())
          ),
          updated_at=now()
      where id=new.comment_event_id and private_reply_sent_at is null;
    end if;
  elsif new.status='sending' and new.comment_event_id is not null then
    update public.v8_comment_events
    set private_reply_status='sending',updated_at=now()
    where id=new.comment_event_id;
  end if;

  return new;
end;
$function$;

revoke execute on function public.v8_customer_has_contact(uuid) from public,anon,authenticated;
revoke execute on function public.v8_v7_slide_request_policy(uuid) from public,anon,authenticated;
revoke execute on function public.v8_v7_slide_outbound_policy(uuid) from public,anon,authenticated;
grant execute on function public.v8_customer_has_contact(uuid) to service_role;
grant execute on function public.v8_v7_slide_request_policy(uuid) to service_role;
grant execute on function public.v8_v7_slide_outbound_policy(uuid) to service_role;
