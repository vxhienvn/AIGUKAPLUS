-- Restore AI-authorized follow-up after customer silence.
-- Follow-up candidates are queued for a dedicated AI decision worker instead of
-- inserting legacy reply plans that are intentionally blocked by AI Brain.

drop function if exists public.v8_claim_ai_dispatch_batch(text,integer);
create function public.v8_claim_ai_dispatch_batch(
  p_worker text,
  p_batch_size integer default 5
)
returns table(
  id uuid,
  page_id text,
  sender_id text,
  message_id text,
  requested_by text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  return query
  with picked as (
    select r.id
    from public.v8_ai_brain_requests r
    where r.status in ('pending','error','processing')
      and r.decision_id is null
      and coalesce(r.attempts,0)<5
      and (
        r.dispatch_locked_at is null
        or r.dispatch_locked_at<now()-interval '2 minutes'
      )
      and (
        r.status in ('pending','error')
        or r.started_at is null
        or r.started_at<now()-interval '2 minutes'
      )
    order by r.created_at asc
    for update skip locked
    limit least(greatest(coalesce(p_batch_size,5),1),10)
  ), upd as (
    update public.v8_ai_brain_requests r
    set status='processing',
        dispatch_locked_at=now(),
        dispatch_locked_by=p_worker,
        started_at=coalesce(r.started_at,now()),
        last_error=null
    from picked p
    where r.id=p.id
    returning r.id,r.page_id,r.sender_id,r.message_id,r.requested_by
  )
  select * from upd;
end;
$function$;

create or replace function public.v8_prepare_follow_up_ai_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r public.v8_ai_brain_requests%rowtype;
  c public.v8_customers%rowtype;
  s public.v8_conversation_states%rowtype;
  m public.v8_messages_raw%rowtype;
  rt public.v8_ai_brain_runtime%rowtype;
  pr public.v8_ai_providers%rowtype;
  pol record;
  v_details jsonb:='{}'::jsonb;
  v_anchor timestamptz;
  v_history jsonb:='[]'::jsonb;
  v_memory jsonb:='{}'::jsonb;
  v_reason text;
begin
  select * into r from public.v8_ai_brain_requests where id=p_request_id for update;
  if r.id is null or r.requested_by<>'follow_up_scan' then
    return jsonb_build_object('ok',false,'error','invalid_follow_up_request');
  end if;
  if r.status not in ('pending','error','processing') then
    return jsonb_build_object('ok',true,'skipped',true,'reason','request_not_pending','status',r.status);
  end if;

  v_details:=coalesce(r.dispatch_details,'{}'::jsonb);
  select * into c from public.v8_customers where page_id=r.page_id and sender_id=r.sender_id limit 1;
  select * into m from public.v8_messages_raw
    where page_id=r.page_id and message_id=v_details->>'last_inbound_message_id' limit 1;
  if c.id is null or m.id is null or m.direction<>'inbound' or m.actor_type<>'customer' then
    v_reason:='follow_up_source_missing';
  else
    select * into s from public.v8_conversation_states where customer_id=c.id;
    select * into pol from public.v8_resolve_runtime_policy(r.page_id) limit 1;
    v_anchor:=nullif(v_details->>'care_anchor_at','')::timestamptz;
    if not coalesce(pol.can_send_text,false) then v_reason:='send_text_not_enabled';
    elsif c.phone is not null or c.zalo is not null or coalesce(s.has_phone,false) then v_reason:='customer_has_contact';
    elsif s.manual_pause_until>now() then v_reason:='human_pause_active';
    elsif m.sent_at<now()-interval '23 hours 45 minutes' then v_reason:='messaging_window_too_close_or_closed';
    elsif exists(select 1 from public.v8_messages_raw x where x.customer_id=c.id and x.direction='inbound' and x.sent_at>m.sent_at) then v_reason:='newer_customer_message';
    elsif exists(select 1 from public.v8_messages_raw x where x.customer_id=c.id and x.direction='outbound' and x.sent_at>coalesce(v_anchor,m.sent_at)) then v_reason:='newer_outbound_after_care_anchor';
    elsif exists(select 1 from public.v8_outbound_queue x where x.customer_id=c.id and x.status in ('planned','ready','sending')) then v_reason:='active_outbound_exists';
    end if;
  end if;

  if v_reason is not null then
    update public.v8_ai_brain_requests
    set status='skipped',completed_at=now(),last_error=v_reason,
        dispatch_details=v_details||jsonb_build_object('follow_up_skipped_reason',v_reason,'follow_up_skipped_at',now())
    where id=r.id;
    return jsonb_build_object('ok',true,'skipped',true,'reason',v_reason);
  end if;

  select * into rt from public.v8_ai_brain_runtime where page_id=r.page_id;
  if rt.page_id is null or rt.mode='OFF' then
    update public.v8_ai_brain_requests set status='skipped',completed_at=now(),last_error='brain_off' where id=r.id;
    return jsonb_build_object('ok',true,'skipped',true,'reason','brain_off');
  end if;
  select * into pr from public.v8_ai_providers where provider_key=coalesce(rt.provider_key,'openai');
  if pr.provider_key is null or not coalesce(pr.is_enabled,false) then
    return jsonb_build_object('ok',false,'error','ai_provider_disabled');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'message_id',x.message_id,'direction',x.direction,'actor_type',x.actor_type,
      'actor_name',x.actor_name,'source_system',x.source_system,'is_automatic',x.is_automatic,
      'text',x.message_text,'has_attachments',coalesce(jsonb_array_length(coalesce(x.attachments,'[]'::jsonb)),0)>0,
      'sent_at',x.sent_at
    ) order by x.sent_at),'[]'::jsonb)
  into v_history
  from (
    select * from public.v8_messages_raw
    where page_id=r.page_id and sender_id=r.sender_id
    order by sent_at desc,created_at desc limit 24
  ) x;

  select coalesce(memory,'{}'::jsonb) into v_memory
  from public.v8_conversation_memory_ai where customer_id=c.id;

  update public.v8_ai_brain_requests
  set status='processing',started_at=coalesce(started_at,now()),attempts=coalesce(attempts,0)+1,last_error=null
  where id=r.id;

  return jsonb_build_object(
    'ok',true,'request_id',r.id,'page_id',r.page_id,'sender_id',r.sender_id,
    'synthetic_message_id',r.message_id,'source_message_id',m.message_id,'source_message_row_id',m.id,
    'customer_id',c.id,'runtime_mode',coalesce(pol.runtime_mode,rt.mode,'PRODUCTION'),
    'model_name',coalesce(rt.model_name,pr.model_name),'provider_key',pr.provider_key,
    'provider_base_url',coalesce(pr.base_url,'https://api.openai.com/v1'),
    'api_key_secret_name',coalesce(pr.api_key_secret_name,'OPENAI_API_KEY'),
    'min_confidence',coalesce(rt.min_confidence_to_reply,.78),
    'details',v_details,
    'customer',jsonb_build_object(
      'display_name',c.display_name,'preferred_salutation',c.preferred_salutation,'gender',c.gender,
      'phone',c.phone,'zalo',c.zalo,'lead_state',c.lead_state,
      'last_product_key',c.last_product_key,'last_intent_type',c.last_intent_type
    ),
    'conversation_state',to_jsonb(s),'memory',v_memory,'conversation',v_history
  );
end;
$function$;
