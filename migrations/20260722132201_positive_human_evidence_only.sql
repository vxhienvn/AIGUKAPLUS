-- Do not infer Sale/Admin solely because two unresolved Page-history rows occur together.
-- Unknown Page activity remains non-blocking until positive human evidence exists.

create or replace function public.v8_track_message_activity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_human_pause_minutes integer:=10;
  v_is_aiguka boolean:=false;
  v_is_automation boolean:=false;
  v_is_human boolean:=false;
  v_is_unknown_page boolean:=false;
  v_has_automation_neighbor boolean:=false;
  v_unknown_cluster_count integer:=0;
  v_pause_until timestamptz;
begin
  if pg_trigger_depth()>1 then return new; end if;
  if new.customer_id is null or new.page_id is null or new.sender_id is null then return new; end if;

  if new.direction='inbound' then
    insert into public.v8_conversation_states(customer_id,page_id,sender_id,last_customer_message_at,last_inbound_message_id)
    values(new.customer_id,new.page_id,new.sender_id,new.sent_at,new.message_id)
    on conflict(customer_id) do update set
      last_customer_message_at=greatest(coalesce(public.v8_conversation_states.last_customer_message_at,'epoch'::timestamptz),excluded.last_customer_message_at),
      last_inbound_message_id=case
        when excluded.last_customer_message_at>=coalesce(public.v8_conversation_states.last_customer_message_at,'epoch'::timestamptz)
          then excluded.last_inbound_message_id
        else public.v8_conversation_states.last_inbound_message_id
      end,
      updated_at=now();
    return new;
  end if;

  if new.direction<>'outbound' then return new; end if;

  v_is_aiguka:=coalesce(new.source_system,'') in ('aiguka','aiguka_v8');
  v_is_automation:=coalesce(new.source_system,'')='meta_page_automation'
    or coalesce(new.is_automatic,false)
    or lower(coalesce(new.actor_type,'')) in ('page_automation','automation','bot','botcake','aicake');
  v_is_human:=public.v8_is_confirmed_human_outbound(
    new.source_system,new.message_text,new.attachments,new.is_automatic,new.actor_type,new.source_detail,new.actor_app_id
  );
  v_is_unknown_page:=public.v8_is_unresolved_page_outbound_candidate(
    new.source_system,new.message_text,new.attachments,new.is_automatic,new.actor_type,new.source_detail
  );

  if v_is_unknown_page and new.sent_at is not null then
    select exists(
      select 1 from public.v8_messages_raw a
      where a.customer_id=new.customer_id
        and a.source_system='meta_page_automation'
        and abs(extract(epoch from (a.sent_at-new.sent_at)))<=20
    ) into v_has_automation_neighbor;

    select count(*) into v_unknown_cluster_count
    from public.v8_messages_raw m
    where m.customer_id=new.customer_id
      and m.direction='outbound'
      and m.sent_at between new.sent_at-interval '90 seconds' and new.sent_at+interval '90 seconds'
      and public.v8_is_unresolved_page_outbound_candidate(
        m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail
      );

    -- Count is audit evidence only. It is never sufficient to pause AI as human takeover.
    if v_has_automation_neighbor then
      v_is_unknown_page:=false;
      v_is_automation:=true;
    end if;
  end if;

  select coalesce((value->>'pause_minutes')::integer,10)
  into v_human_pause_minutes
  from public.v8_config_hub
  where key='human_handoff_policy' and scope='conversation' and is_active
  order by updated_at desc limit 1;
  v_human_pause_minutes:=least(greatest(coalesce(v_human_pause_minutes,10),1),120);
  v_pause_until:=case when v_is_human then new.sent_at+make_interval(mins=>v_human_pause_minutes) end;

  insert into public.v8_conversation_states(
    customer_id,page_id,sender_id,last_outbound_message_at,last_outbound_actor,last_outbound_source,
    last_human_message_at,manual_pause_until,last_automation_message_at,automation_pause_until,
    last_automation_source,last_automation_message_id,metadata
  ) values(
    new.customer_id,new.page_id,new.sender_id,new.sent_at,new.actor_name,new.source_system,
    case when v_is_human then new.sent_at end,
    case when v_is_human then v_pause_until end,
    case when v_is_automation then new.sent_at end,
    null,
    case when v_is_automation then new.source_system end,
    case when v_is_automation then new.message_id end,
    jsonb_build_object(
      'last_outbound_actor_class',case
        when v_is_aiguka then 'aiguka'
        when v_is_automation then 'automation'
        when v_is_human then 'human_confirmed'
        when v_is_unknown_page then 'unknown_settling'
        else 'non_actionable'
      end,
      'actor_settle_delay_seconds',18,
      'unknown_does_not_pause',true,
      'human_requires_positive_evidence',true,
      'unknown_cluster_count',v_unknown_cluster_count,
      'last_outbound_actor_type',new.actor_type,
      'last_outbound_source',new.source_system
    )
  )
  on conflict(customer_id) do update set
    last_outbound_message_at=greatest(coalesce(public.v8_conversation_states.last_outbound_message_at,'epoch'::timestamptz),excluded.last_outbound_message_at),
    last_outbound_actor=case
      when excluded.last_outbound_message_at>=coalesce(public.v8_conversation_states.last_outbound_message_at,'epoch'::timestamptz)
        then excluded.last_outbound_actor else public.v8_conversation_states.last_outbound_actor end,
    last_outbound_source=case
      when excluded.last_outbound_message_at>=coalesce(public.v8_conversation_states.last_outbound_message_at,'epoch'::timestamptz)
        then excluded.last_outbound_source else public.v8_conversation_states.last_outbound_source end,
    last_human_message_at=case when v_is_human
      then greatest(coalesce(public.v8_conversation_states.last_human_message_at,'epoch'::timestamptz),excluded.last_human_message_at)
      else public.v8_conversation_states.last_human_message_at end,
    manual_pause_until=case when v_is_human
      then greatest(coalesce(public.v8_conversation_states.manual_pause_until,'epoch'::timestamptz),excluded.manual_pause_until)
      else public.v8_conversation_states.manual_pause_until end,
    last_automation_message_at=case when v_is_automation
      then greatest(coalesce(public.v8_conversation_states.last_automation_message_at,'epoch'::timestamptz),excluded.last_automation_message_at)
      else public.v8_conversation_states.last_automation_message_at end,
    automation_pause_until=null,
    last_automation_source=case when v_is_automation then excluded.last_automation_source else public.v8_conversation_states.last_automation_source end,
    last_automation_message_id=case when v_is_automation then excluded.last_automation_message_id else public.v8_conversation_states.last_automation_message_id end,
    metadata=coalesce(public.v8_conversation_states.metadata,'{}'::jsonb)||excluded.metadata,
    updated_at=now();
  return new;
end;
$function$;
