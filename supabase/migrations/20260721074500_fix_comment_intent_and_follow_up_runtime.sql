-- Fix comment leads that clearly ask for an address but use natural wording such as
-- "ở chỗ nào". Also prevent a second detector from finding a commercial intent
-- while the comment row remains ignored.

create or replace function public.v8_classify_comment_lead(
  p_message_text text,
  p_sender_id text default null,
  p_page_id text default null,
  p_raw_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_raw text:=btrim(coalesce(p_message_text,''));
  v_norm text:=public.v8_normalize_detector_text(v_raw);
  v_phone text:=public.v8_extract_vietnam_phone(v_raw);
  v_score integer:=0;
  v_status text:='ignored';
  v_intent text;
  v_reason text:='no_commercial_intent';
  v_private_reply boolean:=false;
  v_address boolean:=false;
begin
  if nullif(p_sender_id,'') is null or p_sender_id=p_page_id then
    return jsonb_build_object('lead_status','ignored','lead_score',0,'reason','page_or_missing_sender','auto_private_reply',false);
  end if;
  if nullif(v_raw,'') is null or nullif(v_norm,'') is null then
    return jsonb_build_object('lead_status','ignored','lead_score',0,'reason','empty_or_emoji_only','auto_private_reply',false);
  end if;
  if v_raw ~ '^\s*(@[^[:space:]]+\s*)+$' then
    return jsonb_build_object('lead_status','ignored','lead_score',0,'reason','tag_only','auto_private_reply',false);
  end if;
  if v_phone is not null then
    return jsonb_build_object('lead_status','contact_provided','lead_score',90,'reason','phone_in_comment','intent_type','provide_contact','detected_phone',v_phone,'auto_private_reply',false);
  end if;
  if v_norm ~ '(^| )(lua dao|bao hanh khong|khieu nai|that vong|te qua|kem chat luong|bi loi|hong|khong hai long|boc phot)( |$)' then
    return jsonb_build_object('lead_status','manual_review','lead_score',70,'reason','complaint_or_negative','intent_type','complaint','auto_private_reply',false);
  end if;

  v_address:=v_norm ~ '(^| )(dia chi|o dau|o cho nao|cho nao|cua hang o dau|cua hang o cho nao|shop o dau|showroom o dau|dia diem|vi tri)( |$)';

  if v_address
     or v_norm ~ '(^| )(gia|bao nhieu|bao gia|xin gia|ib|inbox|tu van|xin mau|xem mau|hinh anh|anh that|con hang|ship|van chuyen|bao hanh|kich thuoc|mau nao|mua|dat hang)( |$)' then
    v_status:='qualified';
    v_score:=50;
    v_reason:='commercial_intent';
    v_private_reply:=true;
    v_intent:=case
      when v_address then 'ask_address'
      when v_norm ~ '(^| )(gia|bao nhieu|bao gia|xin gia)( |$)' then 'ask_price'
      when v_norm ~ '(^| )(xin mau|xem mau|hinh anh|anh that)( |$)' then 'ask_sample'
      when v_norm ~ '(^| )(con hang|mua|dat hang)( |$)' then 'ask_consult'
      else 'ask_consult'
    end;
  elsif char_length(v_norm)<=12 and v_norm in ('ib','inbox','tu van','gia','bao gia') then
    v_status:='qualified';
    v_score:=45;
    v_reason:='short_commercial_intent';
    v_private_reply:=true;
    v_intent:='ask_consult';
  elsif v_norm ~ '(^| )(dep|hay|ok|cam on|thank|like)( |$)' then
    v_status:='ignored';
    v_score:=0;
    v_reason:='social_only';
  end if;

  return jsonb_build_object(
    'lead_status',v_status,
    'lead_score',v_score,
    'reason',v_reason,
    'intent_type',v_intent,
    'detected_phone',v_phone,
    'auto_private_reply',v_private_reply
  );
end;
$function$;

create or replace function public.v8_promote_comment_intent_before_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_reason text:=coalesce(new.classifier_reason->>'reason','');
begin
  if coalesce(new.lead_status,'ignored')='ignored'
     and coalesce(new.intent_type,'') in ('ask_address','ask_price','ask_sample','ask_consult')
     and v_reason in ('no_commercial_intent','')
     and nullif(new.sender_id,'') is not null
     and new.sender_id is distinct from new.page_id
     and not coalesce(new.has_contact,false)
     and new.detected_phone is null then
    new.lead_status:='qualified';
    new.lead_score:=greatest(coalesce(new.lead_score,0),50);
    new.classifier_reason:=coalesce(new.classifier_reason,'{}'::jsonb)||jsonb_build_object(
      'reason','intent_detector_promoted',
      'original_reason',nullif(v_reason,''),
      'promoted_intent',new.intent_type,
      'auto_private_reply',true,
      'promoted_at',now()
    );
    if coalesce(new.private_reply_status,'not_planned') not in ('queued','sending','sent','cancelled') then
      new.private_reply_status:='eligible';
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_v8_promote_comment_intent_before_write on public.v8_comment_events;
create trigger trg_v8_promote_comment_intent_before_write
before insert or update of intent_type,lead_status,lead_score,classifier_reason,private_reply_status
on public.v8_comment_events
for each row execute function public.v8_promote_comment_intent_before_write();

-- The follow-up completion RPC previously supplied a small transport metadata
-- object as model_output. The AI-authority guard expects model_output to be the
-- full authoritative payload and rejected an otherwise valid AI decision.
do $migration$
declare
  v_sql text;
  v_patched text;
begin
  select pg_get_functiondef(p.oid) into v_sql
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='v8_complete_follow_up_ai_request';

  v_patched:=replace(
    v_sql,
    'jsonb_build_object(''response_id'',nullif(p_response_id,'''')),''ai_runtime_follow_up''',
    'null,''ai_runtime_follow_up'''
  );
  v_patched:=replace(v_patched,'model_output=excluded.model_output,','model_output=null,');
  if v_patched=v_sql then
    raise exception 'follow-up AI-authority patch anchor not found';
  end if;
  execute v_patched;
end;
$migration$;

-- Ignore the few milliseconds between an outbound transport timestamp and its
-- Messenger history echo. That echo is the same care anchor, not a new reply.
do $migration$
declare
  v_sql text;
  v_patched text;
begin
  select pg_get_functiondef(p.oid) into v_sql
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='v8_prepare_follow_up_ai_request';
  v_patched:=replace(
    v_sql,
    'x.sent_at>coalesce(v_anchor,m.sent_at)',
    'x.sent_at>coalesce(v_anchor,m.sent_at)+interval ''2 seconds'''
  );
  if v_patched=v_sql then raise exception 'prepare follow-up tolerance patch anchor not found'; end if;
  execute v_patched;

  select pg_get_functiondef(p.oid) into v_sql
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='v8_complete_follow_up_ai_request';
  v_patched:=replace(
    v_sql,
    'x.sent_at>coalesce((v_details->>''care_anchor_at'')::timestamptz,m.sent_at)',
    'x.sent_at>coalesce((v_details->>''care_anchor_at'')::timestamptz,m.sent_at)+interval ''2 seconds'''
  );
  if v_patched=v_sql then raise exception 'complete follow-up tolerance patch anchor not found'; end if;
  execute v_patched;
end;
$migration$;

-- Meta error 10900 means another Page tool already used the one-time private
-- comment reply. Do not retry it three times and report a misleading failure.
create or replace function public.v8_fail_outbound(
  p_outbound_id uuid,
  p_worker_name text,
  p_error text,
  p_retry_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  q public.v8_outbound_queue%rowtype;
  v_already_replied boolean:=coalesce(p_error,'') ilike '%Activity already replied to%'
    or coalesce(p_error,'') like '%(#10900)%';
begin
  if v_already_replied then
    update public.v8_outbound_queue
    set status='cancelled',cancelled_at=now(),cancel_reason='COMMENT_ALREADY_REPLIED_EXTERNAL',
        locked_at=null,locked_by=null,authorized_at=null,authorized_by=null,
        authorization_version=null,authorization_details='{}'::jsonb,
        last_error=left(coalesce(p_error,'COMMENT_ALREADY_REPLIED_EXTERNAL'),500),updated_at=now()
    where id=p_outbound_id and status='sending' and locked_by=p_worker_name
    returning * into q;
    if q.id is null then raise exception 'outbound_not_owned_or_not_sending'; end if;

    if q.comment_event_id is not null then
      update public.v8_comment_events
      set private_reply_status='already_replied_external',
          classifier_reason=coalesce(classifier_reason,'{}'::jsonb)||jsonb_build_object(
            'external_private_reply_detected',true,
            'external_reply_reason','META_ACTIVITY_ALREADY_REPLIED',
            'last_transport_error',left(coalesce(p_error,''),500),
            'detected_at',now()
          ),updated_at=now()
      where id=q.comment_event_id;
    end if;
    return jsonb_build_object('ok',true,'outbound_id',q.id,'status',q.status,'reason','COMMENT_ALREADY_REPLIED_EXTERNAL');
  end if;

  update public.v8_outbound_queue
  set status=case when attempts>=max_attempts then 'failed' else 'ready' end,
      due_at=case when attempts>=max_attempts then due_at else now()+make_interval(secs=>least(greatest(coalesce(p_retry_seconds,30),5),3600)) end,
      locked_at=null,locked_by=null,authorized_at=null,authorized_by=null,
      authorization_version=null,authorization_details='{}'::jsonb,
      last_error=left(coalesce(p_error,'unknown_error'),500),updated_at=now()
  where id=p_outbound_id and status='sending' and locked_by=p_worker_name
  returning * into q;
  if q.id is null then raise exception 'outbound_not_owned_or_not_sending'; end if;

  if q.reply_plan_id is not null then
    update public.v8_reply_plans
    set dispatch_status=case when q.status='failed' then 'failed' else 'retry' end
    where id=q.reply_plan_id;
  end if;
  if q.comment_event_id is not null then
    update public.v8_comment_events
    set private_reply_status=case when q.status='failed' then 'failed' else 'queued' end,
        classifier_reason=coalesce(classifier_reason,'{}'::jsonb)||jsonb_build_object(
          'last_transport_error',left(coalesce(p_error,'unknown_error'),500),
          'attempts',q.attempts,
          'max_attempts',q.max_attempts
        ),updated_at=now()
    where id=q.comment_event_id;
  end if;
  return jsonb_build_object('ok',true,'outbound_id',q.id,'status',q.status,'attempts',q.attempts,'max_attempts',q.max_attempts);
end;
$function$;
