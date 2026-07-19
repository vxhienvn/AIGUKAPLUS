-- AIGUKA V8 core repair: actor classification, reply routing, slide state and follow-up.
-- Scope is limited to existing functions; no new product/business capability is introduced.

create or replace function public.v8_jsonb_has_attachments(p_attachments jsonb)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select case
    when p_attachments is null or p_attachments = 'null'::jsonb then false
    when jsonb_typeof(p_attachments)='array' then jsonb_array_length(p_attachments)>0
    when jsonb_typeof(p_attachments)='object' then p_attachments <> '{}'::jsonb
    else false
  end;
$function$;

create or replace function public.v8_is_meta_system_notice(p_message_text text)
returns boolean
language sql
stable
set search_path to 'public'
as $function$
  with n as (
    select public.v8_normalize_detector_text(coalesce(p_message_text,'')) as txt
  )
  select txt ~ '(^| )(da tra loi mot quang cao|da phan hoi mot quang cao|replied to an ad|started a conversation from an ad)( |[.]|$)'
  from n;
$function$;

create or replace function public.v8_is_actionable_external_outbound(
  p_source_system text,
  p_message_text text,
  p_attachments jsonb default '[]'::jsonb,
  p_is_automatic boolean default null,
  p_actor_type text default null,
  p_source_detail jsonb default '{}'::jsonb
)
returns boolean
language sql
stable
set search_path to 'public'
as $function$
  select
    coalesce(p_source_system,'') not in ('aiguka','aiguka_v8','meta_system_notice')
    and not public.v8_is_meta_system_notice(p_message_text)
    and (
      nullif(btrim(coalesce(p_message_text,'')),'') is not null
      or public.v8_jsonb_has_attachments(p_attachments)
    );
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
  v_system integer:=0;
begin
  if nullif(btrim(coalesce(p_page_id,'')),'') is null
     or nullif(btrim(coalesce(p_sender_id,'')),'') is null then
    return jsonb_build_object('ok',false,'reason','PAGE_OR_SENDER_MISSING');
  end if;

  insert into public.v8_customers(
    page_id,sender_id,last_seen_at,raw_profile,meta_conversation_id,
    meta_history_synced_at,history_sync_status,history_sync_error
  )
  values(
    p_page_id,p_sender_id,now(),jsonb_build_object('source','Meta preflight history'),
    p_conversation_id,now(),'synced',null
  )
  on conflict(page_id,sender_id) do update set
    last_seen_at=greatest(public.v8_customers.last_seen_at,excluded.last_seen_at),
    raw_profile=coalesce(public.v8_customers.raw_profile,'{}'::jsonb)||excluded.raw_profile,
    meta_conversation_id=coalesce(excluded.meta_conversation_id,public.v8_customers.meta_conversation_id),
    meta_history_synced_at=now(),history_sync_status='synced',history_sync_error=null
  returning id into v_customer_id;

  with src as (
    select x,
           coalesce(x->'attachments'->'data',x->'attachments','[]'::jsonb) as att,
           (x->'from'->>'id'=p_page_id) as from_page
    from jsonb_array_elements(coalesce(p_messages,'[]'::jsonb)) x
    where nullif(x->>'id','') is not null
  ), classified as (
    select *,
      case
        when from_page and (
          public.v8_is_meta_system_notice(x->>'message')
          or (
            nullif(btrim(coalesce(x->>'message','')),'') is null
            and not public.v8_jsonb_has_attachments(att)
          )
        ) then 'system'
        when from_page then 'outbound'
        else 'inbound'
      end as resolved_direction
    from src
  ), ins as (
    insert into public.v8_messages_raw(
      customer_id,page_id,sender_id,conversation_id,message_id,direction,
      actor_type,actor_name,source_system,is_automatic,actor_confidence,source_detail,
      message_text,attachments,raw_payload,sent_at
    )
    select
      v_customer_id,p_page_id,p_sender_id,coalesce(nullif(p_conversation_id,''),p_sender_id),
      x->>'id',
      resolved_direction,
      case resolved_direction
        when 'system' then 'meta_system'
        when 'outbound' then 'page_or_system'
        else 'customer'
      end,
      case resolved_direction
        when 'system' then 'Meta system'
        when 'outbound' then coalesce(nullif(x->'from'->>'name',''),'Page/nhân viên')
        else coalesce(nullif(x->'from'->>'name',''),'Khách hàng')
      end,
      case resolved_direction
        when 'system' then 'meta_system_notice'
        when 'outbound' then 'meta_page_history'
        else 'meta_customer_history'
      end,
      case resolved_direction when 'system' then true when 'inbound' then false else null end,
      case resolved_direction
        when 'system' then 'system_notice'
        when 'outbound' then 'history_page_origin'
        else 'history_customer'
      end,
      jsonb_build_object(
        'classification',case resolved_direction
          when 'system' then 'meta_system_notice'
          when 'outbound' then 'page_history_preflight'
          else 'customer_history_preflight'
        end,
        'source','meta_conversations_api'
      ),
      nullif(x->>'message',''),
      att,
      jsonb_build_object('source','meta_history_preflight')||x,
      coalesce((x->>'created_time')::timestamptz,now())
    from classified
    on conflict(page_id,message_id) do update set
      direction=excluded.direction,
      actor_type=excluded.actor_type,
      actor_name=excluded.actor_name,
      source_system=excluded.source_system,
      is_automatic=excluded.is_automatic,
      actor_confidence=excluded.actor_confidence,
      source_detail=coalesce(public.v8_messages_raw.source_detail,'{}'::jsonb)||excluded.source_detail,
      message_text=coalesce(excluded.message_text,public.v8_messages_raw.message_text),
      attachments=case
        when public.v8_jsonb_has_attachments(excluded.attachments) then excluded.attachments
        else public.v8_messages_raw.attachments
      end,
      raw_payload=excluded.raw_payload,
      sent_at=least(public.v8_messages_raw.sent_at,excluded.sent_at)
    returning direction
  )
  select count(*),
         count(*) filter(where direction='outbound'),
         count(*) filter(where direction='inbound'),
         count(*) filter(where direction='system')
  into v_inserted,v_outbound,v_inbound,v_system
  from ins;

  return jsonb_build_object(
    'ok',true,'customer_id',v_customer_id,'inserted_or_updated',v_inserted,
    'outbound_rows',v_outbound,'inbound_rows',v_inbound,'system_rows',v_system,
    'human_takeover_possible',v_outbound>0
  );
end;
$function$;

create or replace function public.v8_track_message_activity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_human_pause_minutes integer:=10;
  v_automation_pause_seconds integer:=120;
  v_is_human_or_unknown boolean:=false;
  v_is_external_automation boolean:=false;
  v_is_aiguka boolean:=false;
  v_is_actionable boolean:=false;
  v_pause_until timestamptz;
begin
  if new.customer_id is null or new.page_id is null or new.sender_id is null then
    return new;
  end if;

  if new.direction='inbound' then
    insert into public.v8_conversation_states(
      customer_id,page_id,sender_id,last_customer_message_at,last_inbound_message_id
    ) values(
      new.customer_id,new.page_id,new.sender_id,new.sent_at,new.message_id
    )
    on conflict(customer_id) do update set
      last_customer_message_at=greatest(
        coalesce(public.v8_conversation_states.last_customer_message_at,'epoch'::timestamptz),
        excluded.last_customer_message_at
      ),
      last_inbound_message_id=case
        when excluded.last_customer_message_at>=coalesce(
          public.v8_conversation_states.last_customer_message_at,'epoch'::timestamptz
        ) then excluded.last_inbound_message_id
        else public.v8_conversation_states.last_inbound_message_id
      end,
      updated_at=now();
    return new;
  end if;

  if new.direction<>'outbound' then
    return new;
  end if;

  v_is_aiguka:=coalesce(new.source_system,'') in ('aiguka','aiguka_v8');
  v_is_actionable:=public.v8_is_actionable_external_outbound(
    new.source_system,new.message_text,new.attachments,new.is_automatic,new.actor_type,new.source_detail
  );

  if not v_is_aiguka and not v_is_actionable then
    return new;
  end if;

  select coalesce((value->>'pause_minutes')::integer,10)
    into v_human_pause_minutes
  from public.v8_config_hub
  where key='human_handoff_policy' and scope='conversation' and is_active
  order by updated_at desc limit 1;
  v_human_pause_minutes:=least(greatest(coalesce(v_human_pause_minutes,10),1),120);

  select coalesce(automation_pause_seconds,120)
    into v_automation_pause_seconds
  from public.v8_page_messaging_capabilities
  where page_id=new.page_id;
  v_automation_pause_seconds:=least(greatest(coalesce(v_automation_pause_seconds,120),0),3600);

  if not v_is_aiguka then
    v_is_external_automation:=coalesce(new.is_automatic,false)=true;
    v_is_human_or_unknown:=not v_is_external_automation;
  end if;

  if v_is_human_or_unknown then
    v_pause_until:=new.sent_at+make_interval(mins=>v_human_pause_minutes);
  elsif v_is_external_automation then
    v_pause_until:=new.sent_at+make_interval(secs=>v_automation_pause_seconds);
  else
    v_pause_until:=null;
  end if;

  insert into public.v8_conversation_states(
    customer_id,page_id,sender_id,last_outbound_message_at,last_outbound_actor,last_outbound_source,
    last_human_message_at,manual_pause_until,last_automation_message_at,automation_pause_until,
    last_automation_source,last_automation_message_id,metadata
  ) values(
    new.customer_id,new.page_id,new.sender_id,new.sent_at,new.actor_name,new.source_system,
    case when v_is_human_or_unknown then new.sent_at end,
    case when v_is_human_or_unknown then v_pause_until end,
    case when v_is_external_automation then new.sent_at end,
    case when v_is_external_automation then v_pause_until end,
    case when v_is_external_automation then new.source_system end,
    case when v_is_external_automation then new.message_id end,
    jsonb_build_object(
      'last_outbound_is_automatic',new.is_automatic,
      'last_outbound_actor_type',new.actor_type,
      'last_outbound_source',new.source_system,
      'external_automation',v_is_external_automation,
      'actionable_external',v_is_actionable,
      'aiguka_outbound',v_is_aiguka
    )
  )
  on conflict(customer_id) do update set
    last_outbound_message_at=greatest(
      coalesce(public.v8_conversation_states.last_outbound_message_at,'epoch'::timestamptz),
      excluded.last_outbound_message_at
    ),
    last_outbound_actor=case
      when excluded.last_outbound_message_at>=coalesce(
        public.v8_conversation_states.last_outbound_message_at,'epoch'::timestamptz
      ) then excluded.last_outbound_actor else public.v8_conversation_states.last_outbound_actor end,
    last_outbound_source=case
      when excluded.last_outbound_message_at>=coalesce(
        public.v8_conversation_states.last_outbound_message_at,'epoch'::timestamptz
      ) then excluded.last_outbound_source else public.v8_conversation_states.last_outbound_source end,
    last_human_message_at=case when v_is_human_or_unknown then greatest(
      coalesce(public.v8_conversation_states.last_human_message_at,'epoch'::timestamptz),
      excluded.last_human_message_at
    ) else public.v8_conversation_states.last_human_message_at end,
    manual_pause_until=case when v_is_human_or_unknown then greatest(
      coalesce(public.v8_conversation_states.manual_pause_until,'epoch'::timestamptz),
      excluded.manual_pause_until
    ) else public.v8_conversation_states.manual_pause_until end,
    last_automation_message_at=case when v_is_external_automation then greatest(
      coalesce(public.v8_conversation_states.last_automation_message_at,'epoch'::timestamptz),
      excluded.last_automation_message_at
    ) else public.v8_conversation_states.last_automation_message_at end,
    automation_pause_until=case when v_is_external_automation then greatest(
      coalesce(public.v8_conversation_states.automation_pause_until,'epoch'::timestamptz),
      excluded.automation_pause_until
    ) else public.v8_conversation_states.automation_pause_until end,
    last_automation_source=case when v_is_external_automation
      then excluded.last_automation_source else public.v8_conversation_states.last_automation_source end,
    last_automation_message_id=case when v_is_external_automation
      then excluded.last_automation_message_id else public.v8_conversation_states.last_automation_message_id end,
    metadata=coalesce(public.v8_conversation_states.metadata,'{}'::jsonb)||excluded.metadata,
    updated_at=now();

  return new;
end;
$function$;

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
    set status='cancelled',cancelled_at=now(),cancel_reason='newer_customer_message',updated_at=now()
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
      );
  elsif new.direction='outbound'
    and public.v8_is_actionable_external_outbound(
      new.source_system,new.message_text,new.attachments,new.is_automatic,new.actor_type,new.source_detail
    ) then
    update public.v8_outbound_queue oq
    set status='cancelled',cancelled_at=now(),cancel_reason='external_responder_replied',updated_at=now()
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
    set status='cancelled',cancelled_at=now(),cancel_reason='external_responder_replied',updated_at=now()
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
      );
    get diagnostics v_outbound=row_count;

    update public.v8_slide_logs sl
    set send_status='cancelled',decision_status='cancelled',safety_status='suppressed_external_reply',
        reason=coalesce(sl.reason,'{}'::jsonb)||jsonb_build_object(
          'reconciled_after_external_activity',true,
          'external_message_id',m.message_id,
          'external_sent_at',m.sent_at
        )
    where sl.customer_id=m.customer_id and sl.sent_at is null
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
    set status='cancelled',cancelled_at=now(),cancel_reason='newer_customer_message',updated_at=now()
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
      );
    get diagnostics v_outbound=row_count;

    update public.v8_slide_logs sl
    set send_status='cancelled',decision_status='cancelled',safety_status='suppressed_superseded',
        reason=coalesce(sl.reason,'{}'::jsonb)||jsonb_build_object(
          'reconciled_after_new_customer_message',true,
          'new_message_id',m.message_id,
          'new_message_sent_at',m.sent_at
        )
    from public.v8_messages_raw src
    where sl.customer_id=m.customer_id
      and src.id=sl.message_id
      and src.direction='inbound'
      and src.sent_at<m.sent_at
      and sl.sent_at is null
      and sl.send_status in ('planned','queued');
    get diagnostics v_slides=row_count;
  end if;

  return jsonb_build_object(
    'ok',true,'message_id',m.message_id,
    'reply_plans_reconciled',v_plans,
    'suppressed_plans_marked_old',v_suppressed_marked_old,
    'outbound_cancelled',v_outbound,
    'slides_cancelled',v_slides
  );
end;
$function$;

create or replace function public.v8_get_recent_context(
  p_page_id text,
  p_sender_id text,
  p_before timestamp with time zone
)
returns table(catalog_key text,product_key text)
language sql
stable
set search_path to 'public'
as $function$
  select q.catalog_key,q.product_key
  from public.v8_processing_queue q
  join public.v8_messages_raw m
    on m.page_id=q.page_id and m.message_id=q.message_id
  where q.page_id=p_page_id
    and q.sender_id=p_sender_id
    and q.status='done'
    and m.direction='inbound'
    and m.sent_at<p_before
    and m.sent_at>=p_before-interval '30 minutes'
    and coalesce(q.catalog_key,q.product_key) is not null
  order by m.sent_at desc,q.processed_at desc
  limit 1;
$function$;

-- Deterministic templates for existing direct-address and follow-up flows.
insert into public.v8_reply_templates(
  template_key,template_name,stage,intent_type,business_group_key,body,priority,is_active,metadata
)
values
(
  'answer_address','Trả lời địa chỉ showroom','context','ask_address',null,
  'Dạ showroom bên em tại 254 Phố Keo, Gia Lâm, Hà Nội ạ. {Salutation} cần em gửi định vị hoặc hướng dẫn đường đi không ạ?',
  12,true,jsonb_build_object('core_route',true,'deterministic',true)
),
(
  'follow_up_nudge','Chăm sóc lại khách chưa phản hồi','follow_up','follow_up',null,
  'Dạ em nhắn lại để tránh bỏ sót nhu cầu {group_name} của {salutation}. {Salutation} cần xem mẫu hay báo giá, em hỗ trợ ngay ạ.',
  70,true,jsonb_build_object('core_route',true,'non_promotional',true)
)
on conflict (template_key) do update set
  template_name=excluded.template_name,
  stage=excluded.stage,
  intent_type=excluded.intent_type,
  business_group_key=excluded.business_group_key,
  body=excluded.body,
  priority=excluded.priority,
  is_active=excluded.is_active,
  metadata=coalesce(public.v8_reply_templates.metadata,'{}'::jsonb)||excluded.metadata,
  updated_at=now();

-- Patch reply planner only at the three structural anchors, preserving all unrelated behavior.
do $migration$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef('public.v8_build_reply_plans(timestamp with time zone)'::regprocedure)
    into v_definition;

  v_old:=$old$
      and coalesce(m.source_system,'') not in ('aiguka','aiguka_v8')
$old$;
  v_new:=$new$
      and public.v8_is_actionable_external_outbound(
        m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail
      )
$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'REPLY_PLANNER_EXTERNAL_ACTOR_ANCHOR_NOT_FOUND';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);

  v_old:=$old$
    elsif q.intent_type='provide_location' then
$old$;
  v_new:=$new$
    elsif q.intent_type='ask_address' then
      v_stage:='context';v_action:='answer_address';v_template_key:='answer_address';
    elsif q.intent_type='provide_location' then
$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'REPLY_PLANNER_ADDRESS_ROUTE_ANCHOR_NOT_FOUND';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);

  v_old:=$old$
       and v_action not in ('no_reply_low_information','no_reply_contextual') then
$old$;
  v_new:=$new$
       and v_action not in ('no_reply_low_information','no_reply_contextual','answer_address') then
$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'REPLY_PLANNER_DETERMINISTIC_LEARNING_ANCHOR_NOT_FOUND';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);

  execute v_definition;
end;
$migration$;

-- Patch final gate to ignore Meta system notices and blank history shells.
do $migration$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef('public.v8_evaluate_outbound_gate(uuid)'::regprocedure)
    into v_definition;

  v_old:=$old$
      and coalesce(m.source_system,'') not in ('aiguka','aiguka_v8')
$old$;
  v_new:=$new$
      and public.v8_is_actionable_external_outbound(
        m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail
      )
$new$;
  if position(v_old in v_definition)=0 then
    raise exception 'OUTBOUND_GATE_EXTERNAL_ACTOR_ANCHOR_NOT_FOUND';
  end if;
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
            'cancelled_at',coalesce(new.cancelled_at,now())
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
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_v8_sync_source_status_from_outbound on public.v8_outbound_queue;
create trigger trg_v8_sync_source_status_from_outbound
after update of status,cancel_reason on public.v8_outbound_queue
for each row
when (old.status is distinct from new.status)
execute function public.v8_sync_source_status_from_outbound();

create or replace function public.v8_create_follow_up_tasks(
  p_limit integer default 100,
  p_dry_run boolean default true,
  p_requested_by text default 'manual_test'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cfg jsonb:='{}'::jsonb;
  v_enabled boolean:=true;
  v_auto_send boolean:=false;
  v_create_task_only boolean:=true;
  v_skip_contact_task boolean:=true;
  v_min_hours integer:=8;
  v_max_hours integer:=23;
  v_lookback integer:=24;
  v_min_score integer:=0;
  v_enabled_after timestamptz:='epoch'::timestamptz;
  v_limit integer:=least(greatest(coalesce(p_limit,100),1),500);
  v_candidates jsonb:='[]'::jsonb;
  v_candidate_count integer:=0;
  v_tasks_created integer:=0;
  v_replies_created integer:=0;
begin
  select value into v_cfg
  from public.v8_config_hub
  where key='follow_up_policy' and scope='conversation' and is_active
  order by updated_at desc limit 1;

  v_enabled:=coalesce((v_cfg->>'enabled')::boolean,true);
  v_auto_send:=coalesce((v_cfg->>'auto_send_enabled')::boolean,false);
  v_create_task_only:=coalesce((v_cfg->>'create_sale_task_only')::boolean,true);
  v_skip_contact_task:=coalesce((v_cfg->>'skip_when_contact_task_open')::boolean,true);
  v_min_hours:=least(greatest(coalesce((v_cfg->>'min_delay_hours')::integer,8),1),23);
  v_max_hours:=least(greatest(coalesce((v_cfg->>'max_delay_hours')::integer,23),v_min_hours),23);
  v_lookback:=least(greatest(coalesce((v_cfg->>'scan_lookback_hours')::integer,24),v_max_hours),24);
  v_min_score:=greatest(coalesce((v_cfg->>'min_lead_score')::integer,0),0);
  begin
    v_enabled_after:=coalesce(nullif(v_cfg->>'enabled_after','')::timestamptz,'epoch'::timestamptz);
  exception when others then
    v_enabled_after:='epoch'::timestamptz;
  end;

  if not v_enabled then
    return jsonb_build_object(
      'enabled',false,'dry_run',p_dry_run,'candidates',0,
      'tasks_created',0,'reply_plans_created',0
    );
  end if;

  with candidate_rows as (
    select
      c.id as customer_id,c.page_id,c.sender_id,c.display_name,c.lead_score,
      s.last_customer_message_at,s.last_inbound_message_id,
      c.last_product_key,c.last_intent_type,
      coalesce(bg.group_name,'sản phẩm') as group_name,
      row_number() over(order by s.last_customer_message_at asc,c.lead_score desc) as rn
    from public.v8_customers c
    join public.v8_conversation_states s on s.customer_id=c.id
    left join public.v8_business_product_groups bg on bg.group_key=c.last_product_key
    join lateral public.v8_resolve_runtime_policy(c.page_id) pol on true
    where s.last_customer_message_at between
            now()-make_interval(hours=>v_max_hours)
            and now()-make_interval(hours=>v_min_hours)
      and s.last_customer_message_at>=now()-make_interval(hours=>v_lookback)
      and s.last_customer_message_at>=v_enabled_after
      and coalesce(c.lead_score,0)>=v_min_score
      and c.phone is null and c.zalo is null
      and coalesce(c.last_intent_type,'') not in (
        'provide_contact','decline','decline_contact','decline_interest','acknowledge'
      )
      and coalesce(pol.can_send_text,false)
      and (s.manual_pause_until is null or s.manual_pause_until<=now())
      and (s.automation_pause_until is null or s.automation_pause_until<=now())
      and (s.follow_up_suppressed_until is null or s.follow_up_suppressed_until<=now())
      and s.last_inbound_message_id is not null
      and not exists(
        select 1 from public.v8_messages_raw m
        where m.customer_id=c.id
          and m.direction='outbound'
          and m.sent_at>=s.last_customer_message_at
          and (
            coalesce(m.source_system,'') in ('aiguka','aiguka_v8')
            or public.v8_is_actionable_external_outbound(
              m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail
            )
          )
      )
      and (
        not v_skip_contact_task
        or not exists(
          select 1 from public.v8_sale_tasks st
          where st.customer_id=c.id and st.status='open' and st.task_type='contact_lead'
        )
      )
      and not exists(
        select 1 from public.v8_reply_plans rp
        where rp.customer_id=c.id
          and rp.action_type='follow_up_nudge'
          and rp.created_at>=s.last_customer_message_at
      )
    order by s.last_customer_message_at asc,c.lead_score desc
    limit v_limit
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'customer_id',customer_id,'page_id',page_id,'sender_id',sender_id,
           'display_name',display_name,'lead_score',lead_score,
           'last_customer_message_at',last_customer_message_at,
           'last_inbound_message_id',last_inbound_message_id,
           'last_product_key',last_product_key,'last_intent_type',last_intent_type,
           'group_name',group_name
         ) order by rn),'[]'::jsonb)
  into v_candidate_count,v_candidates
  from candidate_rows;

  if not p_dry_run and v_candidate_count>0 and v_auto_send and not v_create_task_only then
    insert into public.v8_reply_plans(
      customer_id,queue_id,page_id,sender_id,message_id,business_group_key,intent_type,
      conversation_stage,action_type,suggested_reply,should_request_phone,should_ask_need,
      should_handoff_sale,safety_status,reason,send_eligible,blocked_reason,available_after,
      runtime_mode,is_latest_customer_turn
    )
    select
      (x->>'customer_id')::uuid,null,(x->>'page_id'),(x->>'sender_id'),
      x->>'last_inbound_message_id',nullif(x->>'last_product_key',''),'follow_up',
      'follow_up','follow_up_nudge',
      coalesce(
        public.v8_get_reply_template('follow_up_nudge',coalesce(nullif(x->>'group_name',''),'sản phẩm')),
        'Dạ em nhắn lại để tránh bỏ sót nhu cầu của {salutation}. {Salutation} cần xem mẫu hay báo giá, em hỗ trợ ngay ạ.'
      ),
      false,false,false,'ready_to_send',
      jsonb_build_object(
        'follow_up',true,
        'requested_by',coalesce(nullif(p_requested_by,''),'system'),
        'last_customer_message_at',x->>'last_customer_message_at',
        'is_promotional',false,
        'policy',v_cfg
      ),
      true,null,now(),'PRODUCTION',true
    from jsonb_array_elements(v_candidates) x
    where not exists(
      select 1 from public.v8_reply_plans rp
      where rp.customer_id=(x->>'customer_id')::uuid
        and rp.action_type='follow_up_nudge'
        and rp.created_at>=(x->>'last_customer_message_at')::timestamptz
    );
    get diagnostics v_replies_created=row_count;
  end if;

  if not p_dry_run and v_candidate_count>0 and (v_create_task_only or not v_auto_send) then
    insert into public.v8_sale_tasks(
      customer_id,page_id,sender_id,task_type,priority,title,note,due_at,status,assigned_to
    )
    select
      (x->>'customer_id')::uuid,x->>'page_id',x->>'sender_id','follow_up',
      case when coalesce((x->>'lead_score')::integer,0)>=50 then 'high' else 'normal' end,
      'Chăm sóc lại khách chưa được phản hồi',
      concat(
        'Tạo bởi V8 follow-up core. Khách nhắn lúc ',x->>'last_customer_message_at',
        '. Hãy đọc toàn bộ hội thoại trước khi liên hệ. Nguồn yêu cầu: ',
        coalesce(nullif(p_requested_by,''),'manual')
      ),
      now(),'open',null
    from jsonb_array_elements(v_candidates) x
    on conflict(customer_id,task_type)
      where status='open' and customer_id is not null do nothing;
    get diagnostics v_tasks_created=row_count;
  end if;

  return jsonb_build_object(
    'enabled',true,'dry_run',p_dry_run,'requested_by',p_requested_by,
    'min_delay_hours',v_min_hours,'max_delay_hours',v_max_hours,
    'lookback_hours',v_lookback,'minimum_lead_score',v_min_score,
    'enabled_after',v_enabled_after,'limit',v_limit,'candidates',v_candidate_count,
    'tasks_created',v_tasks_created,'reply_plans_created',v_replies_created,
    'auto_send_enabled',v_auto_send,'create_sale_task_only',v_create_task_only,
    'scheduler_enabled',coalesce((v_cfg->>'scheduler_enabled')::boolean,true),
    'items',v_candidates
  );
end;
$function$;

-- Reclassify previously imported Meta notices/blank shells. These rows must not act as Page replies.
with affected as (
  update public.v8_messages_raw m
  set direction='system',
      actor_type='meta_system',
      actor_name='Meta system',
      source_system='meta_system_notice',
      is_automatic=true,
      actor_confidence='system_notice',
      source_detail=coalesce(m.source_detail,'{}'::jsonb)||jsonb_build_object(
        'classification','meta_system_notice',
        'reclassified_at',now(),
        'reclassified_by','20260719_core_repair'
      )
  where m.direction='outbound'
    and coalesce(m.source_system,'')='meta_page_history'
    and (
      public.v8_is_meta_system_notice(m.message_text)
      or (
        nullif(btrim(coalesce(m.message_text,'')),'') is null
        and not public.v8_jsonb_has_attachments(m.attachments)
      )
    )
  returning customer_id
)
select count(*) from affected;

-- Rebuild polluted conversation outbound/pause fields for customers touched by Meta system notices.
with affected as (
  select distinct customer_id
  from public.v8_messages_raw
  where source_system='meta_system_notice' and customer_id is not null
), latest_actual as (
  select a.customer_id,
         o.sent_at as last_outbound_message_at,
         o.actor_name as last_outbound_actor,
         o.source_system as last_outbound_source
  from affected a
  left join lateral (
    select m.sent_at,m.actor_name,m.source_system
    from public.v8_messages_raw m
    where m.customer_id=a.customer_id and m.direction='outbound'
      and (
        coalesce(m.source_system,'') in ('aiguka','aiguka_v8')
        or public.v8_is_actionable_external_outbound(
          m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail
        )
      )
    order by m.sent_at desc
    limit 1
  ) o on true
), latest_human as (
  select a.customer_id,h.sent_at,h.actor_name,h.source_system
  from affected a
  left join lateral (
    select m.sent_at,m.actor_name,m.source_system
    from public.v8_messages_raw m
    where m.customer_id=a.customer_id and m.direction='outbound'
      and public.v8_is_actionable_external_outbound(
        m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail
      )
      and coalesce(m.is_automatic,false)=false
    order by m.sent_at desc
    limit 1
  ) h on true
), latest_auto as (
  select a.customer_id,x.sent_at,x.source_system,x.message_id
  from affected a
  left join lateral (
    select m.sent_at,m.source_system,m.message_id
    from public.v8_messages_raw m
    where m.customer_id=a.customer_id and m.direction='outbound'
      and public.v8_is_actionable_external_outbound(
        m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail
      )
      and coalesce(m.is_automatic,false)=true
    order by m.sent_at desc
    limit 1
  ) x on true
)
update public.v8_conversation_states s
set last_outbound_message_at=la.last_outbound_message_at,
    last_outbound_actor=la.last_outbound_actor,
    last_outbound_source=la.last_outbound_source,
    last_human_message_at=lh.sent_at,
    manual_pause_until=case when lh.sent_at is null then null else lh.sent_at+interval '10 minutes' end,
    last_automation_message_at=lx.sent_at,
    automation_pause_until=case when lx.sent_at is null then null else lx.sent_at+interval '120 seconds' end,
    last_automation_source=lx.source_system,
    last_automation_message_id=lx.message_id,
    metadata=coalesce(s.metadata,'{}'::jsonb)||jsonb_build_object(
      'system_notice_state_rebuilt_at',now(),
      'system_notice_state_rebuilt_by','20260719_core_repair'
    ),
    updated_at=now()
from latest_actual la
join latest_human lh on lh.customer_id=la.customer_id
join latest_auto lx on lx.customer_id=la.customer_id
where s.customer_id=la.customer_id;

-- Synchronize stale slide status with already-cancelled outbound rows.
update public.v8_slide_logs sl
set send_status='cancelled',
    decision_status='cancelled',
    safety_status=case lower(coalesce(oq.cancel_reason,''))
      when 'external_responder_replied' then 'suppressed_external_reply'
      when 'newer_customer_message' then 'suppressed_superseded'
      else 'cancelled_outbound'
    end,
    send_error=coalesce(sl.send_error,oq.cancel_reason),
    reason=coalesce(sl.reason,'{}'::jsonb)||jsonb_build_object(
      'outbound_status_backfilled',true,
      'outbound_id',oq.id,
      'cancel_reason',oq.cancel_reason
    )
from public.v8_outbound_queue oq
where oq.slide_log_id=sl.id
  and oq.status='cancelled'
  and sl.sent_at is null
  and sl.send_status in ('planned','queued');

-- Activate existing care function only for conversations starting after this repair; no historical mass send.
update public.v8_config_hub
set value=coalesce(value,'{}'::jsonb)||jsonb_build_object(
      'enabled',true,
      'scheduler_enabled',true,
      'auto_send_enabled',true,
      'create_sale_task_only',false,
      'min_delay_hours',8,
      'max_delay_hours',23,
      'scan_lookback_hours',24,
      'min_lead_score',0,
      'skip_when_contact_task_open',true,
      'require_no_outbound_after_customer',true,
      'enabled_after',now()
    ),
    updated_at=now()
where key='follow_up_policy' and scope='conversation' and is_active;

-- Regression checks kept as a callable DB function.
create or replace function public.v8_run_core_repair_regression_tests()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with cases(case_key,passed,details) as (
    values
      (
        'meta_ad_notice_is_system',
        public.v8_is_meta_system_notice('Hoa Muống Biển đã trả lời một quảng cáo.'),
        jsonb_build_object('expected',true)
      ),
      (
        'meta_ad_notice_not_external_reply',
        not public.v8_is_actionable_external_outbound(
          'meta_page_history','Hoa Muống Biển đã trả lời một quảng cáo.','[]'::jsonb,null,'page_or_system','{}'::jsonb
        ),
        jsonb_build_object('expected',false)
      ),
      (
        'blank_history_shell_not_external_reply',
        not public.v8_is_actionable_external_outbound(
          'meta_page_history',null,'[]'::jsonb,null,'page_or_system','{}'::jsonb
        ),
        jsonb_build_object('expected',false)
      ),
      (
        'real_page_text_is_external_reply',
        public.v8_is_actionable_external_outbound(
          'meta_page_history','Dạ em chào anh ạ','[]'::jsonb,false,'page_or_system','{}'::jsonb
        ),
        jsonb_build_object('expected',true)
      ),
      (
        'real_page_attachment_is_external_reply',
        public.v8_is_actionable_external_outbound(
          'meta_page_history',null,'[{"type":"image"}]'::jsonb,false,'page_or_system','{}'::jsonb
        ),
        jsonb_build_object('expected',true)
      ),
      (
        'aiguka_not_external_reply',
        not public.v8_is_actionable_external_outbound(
          'aiguka_v8','Dạ em hỗ trợ ạ','[]'::jsonb,true,'bot','{}'::jsonb
        ),
        jsonb_build_object('expected',false)
      ),
      (
        'address_intent_detected',
        coalesce((select intent_type='ask_address' from public.v8_detect_intent_rule('Ở đâu vậy') limit 1),false),
        jsonb_build_object('expected','ask_address')
      ),
      (
        'address_template_available',
        nullif(public.v8_get_reply_template('answer_address','sản phẩm'),'') is not null,
        jsonb_build_object('expected','non_empty')
      ),
      (
        'follow_up_template_available',
        nullif(public.v8_get_reply_template('follow_up_nudge','quạt trần'),'') is not null,
        jsonb_build_object('expected','non_empty')
      )
  )
  select jsonb_build_object(
    'status',case when count(*) filter(where not passed)=0 then 'passed' else 'failed' end,
    'total',count(*),
    'passed',count(*) filter(where passed),
    'failed',count(*) filter(where not passed),
    'cases',jsonb_agg(jsonb_build_object(
      'case_key',case_key,'passed',passed,'details',details
    ) order by case_key)
  )
  from cases;
$function$;
