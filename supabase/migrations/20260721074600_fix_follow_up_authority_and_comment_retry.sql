-- Keep the AI-authority snapshot equal to the full decision payload, tolerate the
-- transport echo of the care anchor, and stop retrying one-time comment replies
-- after Meta confirms another Page tool already used them.

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
  if v_patched=v_sql then
    raise exception 'prepare follow-up tolerance patch anchor not found';
  end if;
  execute v_patched;
end;
$migration$;

do $migration$
declare
  v_sql text;
  v_patched text;
  v_inbound_guard text:='if exists(select 1 from public.v8_messages_raw x where x.customer_id=c.id and x.direction=''inbound'' and x.sent_at>m.sent_at) then v_should:=false; end if;';
  v_outbound_guard text:='if exists(select 1 from public.v8_messages_raw x where x.customer_id=c.id and x.direction=''outbound'' and x.sent_at>coalesce((v_details->>''care_anchor_at'')::timestamptz,m.sent_at)+interval ''2 seconds'') then v_should:=false; end if;';
begin
  select pg_get_functiondef(p.oid) into v_sql
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='v8_complete_follow_up_ai_request';

  v_patched:=replace(v_sql,v_inbound_guard,v_inbound_guard||E'\n  '||v_outbound_guard);
  v_patched:=replace(
    v_patched,
    'jsonb_build_object(''response_id'',nullif(p_response_id,'''')),''ai_runtime_follow_up''',
    'null,''ai_runtime_follow_up'''
  );
  v_patched:=replace(v_patched,'model_output=excluded.model_output,','model_output=null,');
  if v_patched=v_sql then
    raise exception 'complete follow-up authority patch anchors not found';
  end if;
  execute v_patched;
end;
$migration$;

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
    return jsonb_build_object(
      'ok',true,'outbound_id',q.id,'status',q.status,
      'reason','COMMENT_ALREADY_REPLIED_EXTERNAL'
    );
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

  return jsonb_build_object(
    'ok',true,'outbound_id',q.id,'status',q.status,
    'attempts',q.attempts,'max_attempts',q.max_attempts
  );
end;
$function$;
