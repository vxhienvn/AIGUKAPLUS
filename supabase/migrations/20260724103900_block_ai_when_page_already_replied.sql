create or replace function public.v8_guard_ai_plan_on_unresolved_page_response()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_source_at timestamptz;
  v_has_page_reply boolean:=false;
begin
  if new.customer_id is null or new.message_id is null then return new; end if;
  if coalesce(new.reason->>'ai_brain','false')<>'true' then return new; end if;
  if not coalesce(new.send_eligible,false) and coalesce(new.safety_status,'')<>'ready_to_send' then return new; end if;

  select m.sent_at into v_source_at
  from public.v8_messages_raw m
  where m.page_id=new.page_id and m.message_id=new.message_id
  order by m.created_at desc limit 1;
  if v_source_at is null then return new; end if;

  select exists(
    select 1
    from public.v8_messages_raw x
    where x.customer_id=new.customer_id
      and x.direction='outbound'
      and x.sent_at>=v_source_at
      and coalesce(x.source_system,'') not in ('aiguka','aiguka_v8','meta_system_notice')
      and (
        nullif(btrim(coalesce(x.message_text,'')),'') is not null
        or coalesce(jsonb_array_length(coalesce(x.attachments,'[]'::jsonb)),0)>0
        or coalesce(x.actor_type,'') in ('page_automation','page_or_system','human_admin','sale','admin','staff')
      )
  ) into v_has_page_reply;

  if v_has_page_reply then
    new.send_eligible:=false;
    new.safety_status:='suppressed_external_reply';
    new.blocked_reason:='page_already_replied_after_customer_turn';
    new.dispatch_status:='cancelled';
    new.reason:=coalesce(new.reason,'{}'::jsonb)||jsonb_build_object(
      'page_reply_guard',true,
      'page_reply_guard_at',now(),
      'sla_recovery_blocked',true,
      'reason','page_already_replied_after_customer_turn'
    );
  end if;
  return new;
end;
$function$;
