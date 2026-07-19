-- Comment-to-Messenger private reply runtime.
-- Public comment replies remain disabled.

create or replace function public.v8_stage_comment_private_reply(
  p_comment_event_id uuid,
  p_dry_run boolean default true,
  p_requested_by text default 'comment_webhook'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  ce public.v8_comment_events%rowtype;
  v_cfg jsonb:='{}'::jsonb;
  v_policy record;
  v_group_name text:='sản phẩm';
  v_text text;
  v_price jsonb;
  v_min_score integer:=20;
  v_max_age integer:=7;
  v_auto boolean:=true;
  v_outbound_id uuid;
begin
  select * into ce from public.v8_comment_events where id=p_comment_event_id for update;
  if ce.id is null then return jsonb_build_object('ok',false,'staged',false,'reason','COMMENT_EVENT_NOT_FOUND'); end if;
  select value into v_cfg from public.v8_config_hub
  where key='comment_messenger_policy' and scope='conversation' and is_active
  order by updated_at desc limit 1;
  v_min_score:=greatest(coalesce((v_cfg->>'minimum_lead_score')::integer,20),0);
  v_max_age:=least(greatest(coalesce((v_cfg->>'max_comment_age_days')::integer,7),1),7);
  v_auto:=coalesce((v_cfg->>'auto_send_enabled')::boolean,true);

  if not coalesce((v_cfg->>'enabled')::boolean,true) then return jsonb_build_object('ok',true,'staged',false,'reason','COMMENT_MESSENGER_DISABLED'); end if;
  if ce.has_contact or ce.detected_phone is not null then return jsonb_build_object('ok',true,'staged',false,'reason','CONTACT_ALREADY_PROVIDED'); end if;
  if ce.lead_status<>'qualified' or ce.lead_score<v_min_score then return jsonb_build_object('ok',true,'staged',false,'reason','COMMENT_NOT_QUALIFIED','lead_status',ce.lead_status,'lead_score',ce.lead_score); end if;
  if ce.event_time<now()-make_interval(days=>v_max_age) then return jsonb_build_object('ok',true,'staged',false,'reason','COMMENT_PRIVATE_REPLY_WINDOW_EXPIRED'); end if;
  if ce.private_reply_status in ('queued','sending','sent') then return jsonb_build_object('ok',true,'staged',false,'reason','COMMENT_ALREADY_PLANNED','status',ce.private_reply_status); end if;
  if not p_dry_run and not v_auto then return jsonb_build_object('ok',true,'staged',false,'reason','COMMENT_AUTO_SEND_DISABLED'); end if;

  select * into v_policy from public.v8_resolve_runtime_policy(ce.page_id) limit 1;
  if not coalesce(v_policy.can_send_text,false) then
    return jsonb_build_object('ok',true,'staged',false,'reason','PAGE_TEXT_RUNTIME_BLOCKED','runtime_mode',v_policy.runtime_mode);
  end if;

  select group_name into v_group_name from public.v8_business_product_groups where group_key=ce.product_key limit 1;
  v_group_name:=coalesce(v_group_name,'sản phẩm trong bài viết');
  v_text:=case
    when ce.intent_type='ask_address' then coalesce(public.v8_get_reply_template('answer_address',v_group_name),'Dạ showroom bên em tại 254 Phố Keo, Gia Lâm, Hà Nội ạ. Anh/chị cần em gửi định vị không ạ?')
    when ce.intent_type='ask_sample' then 'Dạ em thấy anh/chị đang quan tâm '||v_group_name||' trong bài viết. Anh/chị cần em gửi mẫu thực tế theo kiểu nào ạ?'
    when ce.intent_type='ask_price' then 'Dạ em thấy anh/chị đang quan tâm '||v_group_name||' trong bài viết. Anh/chị cho em biết mẫu hoặc nhu cầu cụ thể để em hỗ trợ đúng thông tin và mức giá ạ.'
    else 'Dạ em thấy anh/chị đang quan tâm '||v_group_name||' trong bài viết. Anh/chị cần xem mẫu hay cần tư vấn thông tin nào ạ?'
  end;
  v_text:=replace(replace(v_text,'{Salutation}','Anh/chị'),'{salutation}','anh/chị');
  v_price:=public.v8_validate_reply_price_safety(v_text,'comment_private_reply',ce.intent_type,ce.product_key,jsonb_build_object('source','comment_to_messenger'));
  if not coalesce((v_price->>'allowed')::boolean,false) then
    return jsonb_build_object('ok',true,'staged',false,'reason',v_price->>'reason','price_safety',v_price);
  end if;

  if p_dry_run then
    return jsonb_build_object('ok',true,'staged',false,'dry_run',true,'reason','ELIGIBLE','comment_event_id',ce.id,'page_id',ce.page_id,'comment_id',ce.comment_id,'text',v_text,'runtime_mode',v_policy.runtime_mode);
  end if;

  insert into public.v8_outbound_queue(
    customer_id,page_id,sender_id,reply_plan_id,slide_log_id,comment_event_id,
    message_type,payload,messaging_channel,utility_message_class,status,due_at
  ) values(
    ce.customer_id,ce.page_id,coalesce(ce.sender_id,ce.comment_id),null,null,ce.id,
    'text',jsonb_build_object(
      'text',v_text,'delivery_mode','comment_private_reply','comment_id',ce.comment_id,
      'post_id',ce.post_id,'ad_id',ce.ad_id,'source_comment_event_id',ce.id,
      'price_safety',v_price,'requested_by',p_requested_by
    ),'private_reply','comment_private_reply','ready',now()
  )
  on conflict(comment_event_id) where comment_event_id is not null do update set
    payload=excluded.payload,due_at=excluded.due_at,
    status=case when public.v8_outbound_queue.status in ('sent','cancelled') then public.v8_outbound_queue.status else 'ready' end,
    updated_at=now()
  returning id into v_outbound_id;

  update public.v8_comment_events
  set private_reply_status='queued',private_reply_text=v_text,updated_at=now()
  where id=ce.id;
  return jsonb_build_object('ok',true,'staged',true,'comment_event_id',ce.id,'outbound_id',v_outbound_id,'text',v_text,'runtime_mode',v_policy.runtime_mode);
end;
$function$;

create or replace function public.v8_auto_stage_comment_private_reply()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_result jsonb;
begin
  if new.lead_status='qualified' and new.private_reply_status='eligible' then
    begin
      v_result:=public.v8_stage_comment_private_reply(new.id,false,'comment_webhook_trigger');
      if not coalesce((v_result->>'staged')::boolean,false)
         and coalesce(v_result->>'reason','') not in ('COMMENT_ALREADY_PLANNED','PAGE_TEXT_RUNTIME_BLOCKED') then
        update public.v8_comment_events
        set classifier_reason=coalesce(classifier_reason,'{}'::jsonb)||jsonb_build_object('stage_result',v_result),updated_at=now()
        where id=new.id;
      end if;
    exception when others then
      update public.v8_comment_events
      set private_reply_status='stage_error',
          classifier_reason=coalesce(classifier_reason,'{}'::jsonb)||jsonb_build_object('stage_error',sqlerrm),
          updated_at=now()
      where id=new.id;
    end;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_v8_auto_stage_comment_private_reply on public.v8_comment_events;
create trigger trg_v8_auto_stage_comment_private_reply
after insert or update of lead_status,private_reply_status on public.v8_comment_events
for each row when (new.lead_status='qualified' and new.private_reply_status='eligible')
execute function public.v8_auto_stage_comment_private_reply();

create or replace function public.v8_evaluate_outbound_gate(p_outbound_id uuid)
returns table(allowed boolean,reason text,details jsonb)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  q public.v8_outbound_queue%rowtype;
  rp public.v8_reply_plans%rowtype;
  sl public.v8_slide_logs%rowtype;
  ce public.v8_comment_events%rowtype;
  s public.v8_conversation_states%rowtype;
  v_policy record;
  v_channel jsonb;
  v_source_at timestamptz;
  v_external_check_after timestamptz;
  v_care_case text;
  v_care_anchor_at timestamptz;
  v_grace integer:=4;
  v_test_allowed boolean:=true;
  v_price jsonb;
begin
  select * into q from public.v8_outbound_queue where id=p_outbound_id;
  if q.id is null then return query select false,'OUTBOUND_NOT_FOUND','{}'::jsonb; return; end if;
  if q.status not in ('ready','sending') then return query select false,'OUTBOUND_NOT_READY',jsonb_build_object('status',q.status); return; end if;
  if q.due_at>now() then return query select false,'NOT_DUE_YET',jsonb_build_object('due_at',q.due_at); return; end if;
  if q.attempts>=q.max_attempts then return query select false,'MAX_ATTEMPTS_REACHED',jsonb_build_object('attempts',q.attempts,'max_attempts',q.max_attempts); return; end if;

  select * into v_policy from public.v8_resolve_runtime_policy(q.page_id) limit 1;
  if q.message_type='text' and not coalesce(v_policy.can_send_text,false) then return query select false,'RUNTIME_TEXT_BLOCKED',jsonb_build_object('runtime_mode',v_policy.runtime_mode,'page_mode',v_policy.page_mode); return; end if;
  if q.message_type='image' and not coalesce(v_policy.can_send_image,false) then return query select false,'RUNTIME_IMAGE_BLOCKED',jsonb_build_object('runtime_mode',v_policy.runtime_mode,'page_mode',v_policy.page_mode); return; end if;
  if coalesce(v_policy.runtime_mode,'OBSERVE')='TEST' then
    v_test_allowed:=public.v8_is_test_recipient(q.page_id,q.sender_id,q.message_type);
    if not v_test_allowed then return query select false,'TEST_RECIPIENT_NOT_ALLOWED',jsonb_build_object('page_id',q.page_id,'sender_id',q.sender_id,'message_type',q.message_type); return; end if;
  end if;

  if q.comment_event_id is not null then
    select * into ce from public.v8_comment_events where id=q.comment_event_id;
    if ce.id is null then return query select false,'COMMENT_EVENT_NOT_FOUND','{}'::jsonb; return; end if;
    if ce.has_contact or ce.detected_phone is not null then return query select false,'COMMENT_CONTACT_ALREADY_PROVIDED',jsonb_build_object('comment_id',ce.comment_id); return; end if;
    if ce.lead_status<>'qualified' then return query select false,'COMMENT_NOT_QUALIFIED',jsonb_build_object('lead_status',ce.lead_status,'lead_score',ce.lead_score); return; end if;
    if ce.event_time<now()-interval '7 days' then return query select false,'COMMENT_PRIVATE_REPLY_WINDOW_EXPIRED',jsonb_build_object('event_time',ce.event_time); return; end if;
    if ce.private_reply_sent_at is not null or ce.private_reply_status='sent' then return query select false,'COMMENT_ALREADY_REPLIED',jsonb_build_object('sent_at',ce.private_reply_sent_at); return; end if;
    if nullif(btrim(coalesce(q.payload->>'comment_id','')),'') is null then return query select false,'COMMENT_ID_MISSING','{}'::jsonb; return; end if;
    if nullif(btrim(coalesce(q.payload->>'text','')),'') is null then return query select false,'EMPTY_REPLY','{}'::jsonb; return; end if;
    v_price:=coalesce(q.payload->'price_safety',public.v8_validate_reply_price_safety(q.payload->>'text','comment_private_reply',ce.intent_type,ce.product_key,'{}'::jsonb));
    if not coalesce((v_price->>'allowed')::boolean,false) then return query select false,coalesce(v_price->>'reason','COMMENT_PRICE_SAFETY_BLOCKED'),v_price; return; end if;
    return query select true,'ALLOWED',jsonb_build_object('runtime_mode',v_policy.runtime_mode,'message_type','comment_private_reply','comment_event_id',ce.id,'comment_id',ce.comment_id,'event_time',ce.event_time,'private_reply_window_days',7,'test_recipient_allowed',case when v_policy.runtime_mode='TEST' then v_test_allowed else null end); return;
  end if;

  select * into s from public.v8_conversation_states where customer_id=q.customer_id;
  if s.manual_pause_until>now() then return query select false,'HUMAN_PAUSE_ACTIVE',jsonb_build_object('pause_until',s.manual_pause_until,'last_actor',s.last_outbound_actor); return; end if;
  if s.automation_pause_until>now() then return query select false,'AUTOMATION_PAUSE_ACTIVE',jsonb_build_object('pause_until',s.automation_pause_until,'source',s.last_automation_source); return; end if;
  select coalesce(automation_grace_seconds,4) into v_grace from public.v8_page_messaging_capabilities where page_id=q.page_id;
  v_grace:=least(greatest(coalesce(v_grace,4),0),120);

  if q.reply_plan_id is not null then
    select * into rp from public.v8_reply_plans where id=q.reply_plan_id;
    if rp.id is null then return query select false,'REPLY_PLAN_NOT_FOUND','{}'::jsonb; return; end if;
    if not rp.send_eligible or rp.safety_status<>'ready_to_send' then return query select false,'REPLY_PLAN_NOT_SENDABLE',jsonb_build_object('send_eligible',rp.send_eligible,'safety_status',rp.safety_status,'blocked_reason',rp.blocked_reason); return; end if;
    if not coalesce(rp.is_latest_customer_turn,false) then return query select false,'NOT_LATEST_CUSTOMER_TURN','{}'::jsonb; return; end if;
    if nullif(btrim(coalesce(rp.suggested_reply,'')),'') is null then return query select false,'EMPTY_REPLY','{}'::jsonb; return; end if;
    if coalesce(rp.dispatch_status,'not_staged')='sent' then return query select false,'ALREADY_SENT','{}'::jsonb; return; end if;
    select m.sent_at into v_source_at from public.v8_messages_raw m where m.page_id=rp.page_id and m.message_id=rp.message_id limit 1;
    v_care_case:=coalesce(rp.reason->>'care_case','');
    begin v_care_anchor_at:=nullif(rp.reason->>'care_anchor_at','')::timestamptz; exception when others then v_care_anchor_at:=null; end;
    v_channel:=public.v8_resolve_messaging_channel(rp.page_id,rp.customer_id,rp.utility_message_class,coalesce((rp.reason->>'is_promotional')::boolean,false));
    if not coalesce((v_channel->>'send_allowed_by_window')::boolean,false) then return query select false,'MESSAGING_WINDOW_BLOCKED',v_channel; return; end if;
  elsif q.slide_log_id is not null then
    select * into sl from public.v8_slide_logs where id=q.slide_log_id;
    if sl.id is null then return query select false,'SLIDE_LOG_NOT_FOUND','{}'::jsonb; return; end if;
    if sl.send_status<>'queued' or sl.safety_status<>'ready_to_send' then return query select false,'SLIDE_NOT_SENDABLE',jsonb_build_object('send_status',sl.send_status,'safety_status',sl.safety_status); return; end if;
    if nullif(btrim(coalesce(sl.slide_url,'')),'') is null then return query select false,'SLIDE_URL_MISSING','{}'::jsonb; return; end if;
    select m.sent_at into v_source_at from public.v8_messages_raw m where m.id=sl.message_id limit 1;
    if s.last_customer_message_at is null or s.last_customer_message_at<now()-interval '24 hours' then return query select false,'IMAGE_OUTSIDE_STANDARD_WINDOW',jsonb_build_object('last_customer_message_at',s.last_customer_message_at); return; end if;
  else
    return query select false,'OUTBOUND_SOURCE_MISSING','{}'::jsonb; return;
  end if;

  if v_source_at is null then return query select false,'SOURCE_MESSAGE_NOT_FOUND','{}'::jsonb; return; end if;
  if v_source_at+make_interval(secs=>v_grace)>now() then return query select false,'PAGE_AUTOMATION_GRACE_ACTIVE',jsonb_build_object('ready_at',v_source_at+make_interval(secs=>v_grace)); return; end if;
  if exists(select 1 from public.v8_messages_raw m where m.customer_id=q.customer_id and m.direction='inbound' and m.sent_at>v_source_at) then return query select false,'NEWER_CUSTOMER_MESSAGE','{}'::jsonb; return; end if;
  v_external_check_after:=v_source_at;
  if v_care_case in ('sale_silence_8h','low_value_sale_takeover') and v_care_anchor_at is not null then v_external_check_after:=v_care_anchor_at+interval '1 millisecond'; end if;
  if exists(select 1 from public.v8_messages_raw m where m.customer_id=q.customer_id and m.direction='outbound' and m.sent_at>=v_external_check_after and public.v8_is_actionable_external_outbound(m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail)) then return query select false,'EXTERNAL_RESPONDER_REPLIED','{}'::jsonb; return; end if;
  return query select true,'ALLOWED',jsonb_build_object('runtime_mode',v_policy.runtime_mode,'message_type',q.message_type,'source_message_at',v_source_at,'care_case',nullif(v_care_case,''),'care_anchor_at',v_care_anchor_at,'messaging_channel',case when q.reply_plan_id is not null then v_channel->>'channel' else 'standard_24h' end,'automation_grace_seconds',v_grace,'test_recipient_allowed',case when v_policy.runtime_mode='TEST' then v_test_allowed else null end);
end;
$function$;

create or replace function public.v8_complete_outbound(p_outbound_id uuid,p_worker_name text,p_external_message_id text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare q public.v8_outbound_queue%rowtype;v_message_id text;v_generation bigint;
begin
  select * into q from public.v8_outbound_queue where id=p_outbound_id for update;
  if q.id is null then raise exception 'outbound_not_found'; end if;
  if q.status<>'sending' or q.locked_by is distinct from p_worker_name then raise exception 'outbound_not_owned_or_not_sending'; end if;
  if q.authorized_at is null or q.authorized_by is distinct from p_worker_name or q.authorization_version<>'final_gate_v2' or q.authorized_at<now()-interval '45 seconds' then raise exception 'outbound_not_authorized_or_authorization_expired'; end if;
  if q.transport_confirmed_at is null or q.transport_confirmed_by is distinct from p_worker_name or q.transport_confirmed_at<now()-interval '15 seconds' then raise exception 'outbound_transport_not_confirmed_or_confirmation_expired'; end if;
  select generation into v_generation from public.v8_bot_kill_switch where singleton_key='global';
  if q.control_generation is distinct from v_generation or nullif(q.authorization_details->>'control_generation','')::bigint is distinct from v_generation then
    update public.v8_outbound_queue set status='cancelled',cancelled_at=now(),cancel_reason='BOT_CONTROL_CHANGED_DURING_TRANSPORT',locked_at=null,locked_by=null,authorized_at=null,authorized_by=null,authorization_version=null,authorization_details='{}'::jsonb,transport_confirmed_at=null,transport_confirmed_by=null,updated_at=now() where id=q.id;
    raise exception 'bot_control_changed_during_transport';
  end if;
  v_message_id:=coalesce(nullif(btrim(p_external_message_id),''),'aiguka:'||q.id::text);
  update public.v8_outbound_queue set status='sent',sent_at=now(),locked_at=null,locked_by=null,last_error=null,updated_at=now() where id=q.id;

  if q.comment_event_id is not null then
    update public.v8_comment_events set private_reply_status='sent',private_reply_message_id=v_message_id,private_reply_sent_at=now(),updated_at=now() where id=q.comment_event_id;
    return jsonb_build_object('ok',true,'outbound_id',q.id,'status','sent','message_id',v_message_id,'delivery_mode','comment_private_reply','comment_event_id',q.comment_event_id,'authorization_version',q.authorization_version,'transport_confirmed_at',q.transport_confirmed_at,'control_generation',q.control_generation);
  end if;

  if q.reply_plan_id is not null then update public.v8_reply_plans set dispatch_status='sent',dispatched_at=coalesce(dispatched_at,now()),sent_at=now(),outbound_message_id=v_message_id where id=q.reply_plan_id; end if;
  if q.slide_log_id is not null then update public.v8_slide_logs set send_status='sent',sent_at=now(),safety_status='sent' where id=q.slide_log_id; end if;
  insert into public.v8_messages_raw(customer_id,page_id,sender_id,conversation_id,message_id,direction,actor_type,actor_name,source_system,is_automatic,message_text,attachments,raw_payload,sent_at)
  values(q.customer_id,q.page_id,q.sender_id,q.sender_id,v_message_id,'outbound','aiguka','AIGUKA','aiguka_v8',true,case when q.message_type='text' then q.payload->>'text' else null end,case when q.message_type='image' then jsonb_build_array(jsonb_build_object('url',q.payload->>'url')) else '[]'::jsonb end,jsonb_build_object('source','v8_outbound_queue','outbound_queue_id',q.id,'message_type',q.message_type,'authorization_version',q.authorization_version,'authorized_at',q.authorized_at,'transport_confirmed_at',q.transport_confirmed_at,'control_generation',q.control_generation),now())
  on conflict(page_id,message_id) do nothing;
  return jsonb_build_object('ok',true,'outbound_id',q.id,'status','sent','message_id',v_message_id,'authorization_version',q.authorization_version,'transport_confirmed_at',q.transport_confirmed_at,'control_generation',q.control_generation);
end;
$function$;

create or replace function public.v8_fail_outbound(p_outbound_id uuid,p_worker_name text,p_error text,p_retry_seconds integer default 30)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare q public.v8_outbound_queue%rowtype;
begin
  update public.v8_outbound_queue set status=case when attempts>=max_attempts then 'failed' else 'ready' end,due_at=case when attempts>=max_attempts then due_at else now()+make_interval(secs=>least(greatest(coalesce(p_retry_seconds,30),5),3600)) end,locked_at=null,locked_by=null,authorized_at=null,authorized_by=null,authorization_version=null,authorization_details='{}'::jsonb,last_error=left(coalesce(p_error,'unknown_error'),500),updated_at=now()
  where id=p_outbound_id and status='sending' and locked_by=p_worker_name returning * into q;
  if q.id is null then raise exception 'outbound_not_owned_or_not_sending'; end if;
  if q.reply_plan_id is not null then update public.v8_reply_plans set dispatch_status=case when q.status='failed' then 'failed' else 'retry' end where id=q.reply_plan_id; end if;
  if q.comment_event_id is not null then update public.v8_comment_events set private_reply_status=case when q.status='failed' then 'failed' else 'queued' end,classifier_reason=coalesce(classifier_reason,'{}'::jsonb)||jsonb_build_object('last_transport_error',left(coalesce(p_error,'unknown_error'),500),'attempts',q.attempts,'max_attempts',q.max_attempts),updated_at=now() where id=q.comment_event_id; end if;
  return jsonb_build_object('ok',true,'outbound_id',q.id,'status',q.status,'attempts',q.attempts,'max_attempts',q.max_attempts);
end;
$function$;

create or replace function public.v8_sync_source_status_from_outbound()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_safety text;
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status='cancelled' then
    v_safety:=case lower(coalesce(new.cancel_reason,'')) when 'external_responder_replied' then 'suppressed_external_reply' when 'newer_customer_message' then 'suppressed_superseded' else 'cancelled_outbound' end;
    if new.slide_log_id is not null then update public.v8_slide_logs set send_status='cancelled',decision_status='cancelled',safety_status=v_safety,send_error=coalesce(send_error,new.cancel_reason),reason=coalesce(reason,'{}'::jsonb)||jsonb_build_object('outbound_status_synced',true,'outbound_id',new.id,'cancel_reason',new.cancel_reason,'cancelled_at',coalesce(new.cancelled_at,now())) where id=new.slide_log_id and sent_at is null and send_status in ('planned','queued'); end if;
    if new.reply_plan_id is not null then update public.v8_reply_plans set send_eligible=false,dispatch_status='cancelled',blocked_reason=coalesce(blocked_reason,new.cancel_reason),safety_status=case when safety_status like 'suppressed%' then safety_status else v_safety end,reason=coalesce(reason,'{}'::jsonb)||jsonb_build_object('outbound_status_synced',true,'outbound_id',new.id,'cancel_reason',new.cancel_reason,'cancelled_at',coalesce(new.cancelled_at,now())) where id=new.reply_plan_id and coalesce(dispatch_status,'not_staged')<>'sent'; end if;
    if new.comment_event_id is not null then update public.v8_comment_events set private_reply_status='cancelled',classifier_reason=coalesce(classifier_reason,'{}'::jsonb)||jsonb_build_object('outbound_status_synced',true,'outbound_id',new.id,'cancel_reason',new.cancel_reason,'cancelled_at',coalesce(new.cancelled_at,now())),updated_at=now() where id=new.comment_event_id and private_reply_sent_at is null; end if;
  elsif new.status='sending' and new.comment_event_id is not null then
    update public.v8_comment_events set private_reply_status='sending',updated_at=now() where id=new.comment_event_id;
  end if;
  return new;
end;
$function$;
