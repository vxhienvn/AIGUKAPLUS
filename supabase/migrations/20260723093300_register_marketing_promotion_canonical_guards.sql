create or replace function public.v8_apply_decision_snapshot_guard()
returns trigger
language plpgsql
security definer
set search_path='public'
as $function$
declare
  v_snapshot jsonb;
  v_snapshot_id uuid;
  v_last_inbound_id text;
  v_verified_marketing_optin boolean:=false;
begin
  if new.customer_id is null or nullif(new.message_id,'') is null then return new; end if;
  v_snapshot:=public.v8_build_conversation_snapshot(new.customer_id,new.message_id);
  if not coalesce((v_snapshot->>'ok')::boolean,false) then return new; end if;

  insert into public.v8_conversation_snapshots(customer_id,page_id,sender_id,anchor_message_id,anchor_at,snapshot,updated_at)
  values(new.customer_id,new.page_id,new.sender_id,new.message_id,nullif(v_snapshot->>'anchor_at','')::timestamptz,v_snapshot,now())
  on conflict(customer_id,anchor_message_id) do update set snapshot=excluded.snapshot,anchor_at=excluded.anchor_at,updated_at=now()
  returning id into v_snapshot_id;

  new.reason:=coalesce(new.reason,'{}'::jsonb)||jsonb_build_object(
    'conversation_snapshot_id',v_snapshot_id,
    'conversation_snapshot_version',v_snapshot->>'snapshot_version',
    'snapshot_has_contact',coalesce((v_snapshot->>'has_contact')::boolean,false),
    'snapshot_last_message_id',v_snapshot->'last_message'->>'message_id',
    'snapshot_last_direction',v_snapshot->'last_message'->>'direction'
  );

  select exists(
    select 1 from public.v8_messages_raw m
    where m.customer_id=new.customer_id
      and m.page_id=new.page_id
      and m.message_id=new.message_id
      and m.source_system='meta_marketing_optin'
      and m.direction='system'
      and coalesce(m.source_detail->>'classification','')='marketing_messages_optin'
  ) into v_verified_marketing_optin;

  if v_verified_marketing_optin and new.action_type='promotion_carousel' then
    new.is_latest_customer_turn:=true;
    new.reason:=new.reason||jsonb_build_object('verified_marketing_optin_source',true);
  else
    v_last_inbound_id:=v_snapshot->'last_inbound'->>'message_id';
    if v_last_inbound_id is distinct from new.message_id and coalesce(new.dispatch_status,'not_staged')<>'sent' then
      new.send_eligible:=false;
      new.safety_status:='suppressed_superseded';
      new.blocked_reason:='snapshot_newer_customer_turn_exists';
      new.is_latest_customer_turn:=false;
      return new;
    end if;
  end if;

  if coalesce((v_snapshot->>'has_contact')::boolean,false)
     and coalesce(new.action_type,'') in (
       'request_phone','capture_multi_product_contact','follow_up_nudge','ask_product_group',
       'tease_and_ask_need','price_tease_no_repeat'
     ) then
    new.send_eligible:=false;
    new.safety_status:='suppressed_contact_lock';
    new.blocked_reason:='customer_already_has_phone_or_zalo';
    new.should_request_phone:=false;
    return new;
  end if;
  return new;
end;
$function$;

create or replace function public.v8_ai_guard_legacy_reply_plan()
returns trigger
language plpgsql
set search_path='public'
as $function$
declare
  v_is_ai_plan boolean:=false;
  v_is_verified_marketing_plan boolean:=false;
begin
  v_is_verified_marketing_plan:=
    coalesce(new.action_type,'')='promotion_carousel'
    and coalesce((new.reason->>'is_promotional')::boolean,false)
    and coalesce(new.reason->>'source_system','')='meta_marketing_optin'
    and nullif(new.reason->>'promotion_delivery_id','') is not null
    and coalesce(new.pipeline_version,'')='promotion_v1';

  v_is_ai_plan:=new.ai_decision_id is not null
    or coalesce((new.reason->>'ai_brain')::boolean,false)
    or nullif(new.reason->>'ai_decision_id','') is not null
    or nullif(new.reason->>'decision_id','') is not null
    or coalesce(new.action_type,'') in ('ai_reply','ai_clarification','ai_follow_up','ai_response')
    or v_is_verified_marketing_plan;

  if exists(select 1 from public.v8_ai_brain_runtime r where r.page_id=new.page_id and r.mode='ACTIVE')
     and not v_is_ai_plan then
    new.send_eligible:=false;
    new.safety_status:='suppressed_ai_brain_active';
    new.blocked_reason:='legacy_reply_engine_disabled';
    new.action_type:='legacy_disabled_by_ai_brain';
    new.suggested_reply:='';
    new.dispatch_status:='cancelled';
    new.pipeline_version:='legacy_blocked';
  end if;
  return new;
end;
$function$;
