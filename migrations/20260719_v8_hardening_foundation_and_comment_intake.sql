-- AIGUKA V8 hardening foundation.
-- Restores V2-V7 business-rule parity without adding unrelated features.

create table if not exists public.v8_conversation_snapshots (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.v8_customers(id) on delete cascade,
  page_id text not null,
  sender_id text not null,
  anchor_message_id text not null,
  anchor_at timestamptz,
  snapshot jsonb not null default '{}'::jsonb,
  snapshot_version text not null default 'v8_snapshot_v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(customer_id,anchor_message_id)
);
create index if not exists idx_v8_conversation_snapshots_customer_created
  on public.v8_conversation_snapshots(customer_id,created_at desc);
alter table public.v8_conversation_snapshots enable row level security;

create table if not exists public.v8_comment_events (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  comment_id text not null,
  parent_id text,
  post_id text,
  sender_id text,
  sender_name text,
  message_text text,
  event_time timestamptz not null default now(),
  verb text,
  item_type text,
  ad_id text,
  adset_id text,
  campaign_id text,
  product_key text,
  catalog_key text,
  intent_type text,
  lead_score integer not null default 0,
  lead_status text not null default 'new',
  classifier_reason jsonb not null default '{}'::jsonb,
  has_contact boolean not null default false,
  detected_phone text,
  private_reply_status text not null default 'not_planned',
  private_reply_text text,
  private_reply_message_id text,
  private_reply_sent_at timestamptz,
  customer_id uuid references public.v8_customers(id) on delete set null,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(page_id,comment_id)
);
create index if not exists idx_v8_comment_events_status_time
  on public.v8_comment_events(lead_status,private_reply_status,event_time desc);
create index if not exists idx_v8_comment_events_post
  on public.v8_comment_events(page_id,post_id,event_time desc);
create index if not exists idx_v8_comment_events_sender
  on public.v8_comment_events(page_id,sender_id,event_time desc);
alter table public.v8_comment_events enable row level security;

alter table public.v8_outbound_queue add column if not exists comment_event_id uuid;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='v8_outbound_queue_comment_event_id_fkey') then
    alter table public.v8_outbound_queue
      add constraint v8_outbound_queue_comment_event_id_fkey
      foreign key(comment_event_id) references public.v8_comment_events(id) on delete cascade;
  end if;
end $$;
create unique index if not exists uq_v8_outbound_comment_event
  on public.v8_outbound_queue(comment_event_id) where comment_event_id is not null;
alter table public.v8_outbound_queue drop constraint if exists v8_outbound_queue_source_chk;
alter table public.v8_outbound_queue add constraint v8_outbound_queue_source_chk check (
  ((reply_plan_id is not null)::integer +
   (slide_log_id is not null)::integer +
   (comment_event_id is not null)::integer)=1
);

insert into public.v8_config_hub(key,scope,value,is_active,updated_at)
values(
  'comment_messenger_policy','conversation',
  jsonb_build_object(
    'enabled',true,
    'auto_send_enabled',true,
    'minimum_lead_score',20,
    'max_comment_age_days',7,
    'skip_when_contact_provided',true,
    'skip_complaints_for_manual_review',true,
    'private_reply_only',true,
    'public_comment_reply_enabled',false,
    'version','comment_to_messenger_v1'
  ),true,now()
)
on conflict(key,scope) do update set
  value=excluded.value,is_active=true,updated_at=now();

create or replace function public.v8_sale_reply_quality(
  p_message_text text,
  p_attachments jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_norm text:=public.v8_normalize_detector_text(coalesce(p_message_text,''));
  v_has_attachment boolean:=public.v8_jsonb_has_attachments(p_attachments);
  v_contact_request boolean:=false;
  v_generic_promise boolean:=false;
  v_concrete_value boolean:=false;
  v_score integer:=0;
  v_wait integer:=8;
begin
  v_contact_request:=v_norm ~ '(^| )(xin|cho|gui|de lai|ket ban|ib|nhan)(.{0,35})(so dien thoai|sdt|zalo|za lo|so zalo|so dt)( |$)'
    or v_norm ~ '(so dien thoai|sdt|zalo|za lo).{0,35}(tu van|bao gia|gui mau|lien he)';
  v_generic_promise:=v_norm ~ '(^| )(bao gia|tu van|gui mau|gui anh|chon mau|ho tro)(.{0,45})(qua zalo|qua so|khi co so|sau khi de lai so|cho xin so|de lai so)( |$)';
  v_concrete_value:=v_has_attachment
    or v_norm ~ '([0-9]+([.,][0-9]+)*)[[:space:]]*(k|nghin|trieu|tr|ty|ti|d|dong|vnd)'
    or v_norm ~ '[0-9]+[[:space:]]*(cm|mm|m2|m²|w|kw|nam|thang|km)( |$)'
    or v_norm ~ '(^| )(bao hanh [0-9]+|mien phi van chuyen|giao trong|lap dat tai|showroom tai|dia chi [0-9]+|pho keo|mot ho|hai ho|inox 304|dong co|cong suat|kich thuoc [0-9]+|chat lieu|xuat xu|thuong hieu)( |$)';

  if v_has_attachment then v_score:=v_score+60; end if;
  if v_concrete_value then v_score:=greatest(v_score,70); end if;
  if v_contact_request then v_score:=v_score-25; end if;
  if v_generic_promise then v_score:=v_score-20; end if;
  v_score:=least(greatest(v_score,0),100);

  if v_concrete_value then v_wait:=8;
  elsif v_contact_request and char_length(v_norm)<=120 then v_wait:=1;
  elsif v_contact_request or v_generic_promise then v_wait:=2;
  else v_wait:=8;
  end if;

  return jsonb_build_object(
    'score',v_score,'wait_hours',v_wait,'has_attachment',v_has_attachment,
    'contact_request',v_contact_request,'generic_promise',v_generic_promise,
    'concrete_value',v_concrete_value,
    'classification',case
      when v_concrete_value then 'value_provided'
      when v_wait=1 then 'only_contact_request'
      when v_wait=2 then 'low_value_generic_followup'
      else 'neutral_or_unknown'
    end
  );
end;
$function$;

create or replace function public.v8_sale_reply_wait_hours(
  p_message_text text,
  p_attachments jsonb default '[]'::jsonb
)
returns integer
language sql
stable
set search_path to 'public'
as $function$
  select coalesce((public.v8_sale_reply_quality(p_message_text,p_attachments)->>'wait_hours')::integer,8);
$function$;

create or replace function public.v8_build_conversation_snapshot(
  p_customer_id uuid,
  p_anchor_message_id text default null
)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  c public.v8_customers%rowtype;
  s public.v8_conversation_states%rowtype;
  v_anchor text;
  v_anchor_at timestamptz;
  v_messages jsonb:='[]'::jsonb;
  v_last_message jsonb:='{}'::jsonb;
  v_last_inbound jsonb:='{}'::jsonb;
  v_last_human jsonb:='{}'::jsonb;
  v_last_bot jsonb:='{}'::jsonb;
  v_slide_count integer:=0;
  v_phone_requests integer:=0;
begin
  select * into c from public.v8_customers where id=p_customer_id;
  if c.id is null then return jsonb_build_object('ok',false,'reason','CUSTOMER_NOT_FOUND'); end if;
  select * into s from public.v8_conversation_states where customer_id=p_customer_id;
  v_anchor:=coalesce(nullif(p_anchor_message_id,''),s.last_inbound_message_id);
  select sent_at into v_anchor_at from public.v8_messages_raw
    where customer_id=p_customer_id and message_id=v_anchor order by sent_at desc limit 1;

  select coalesce(jsonb_agg(x.obj order by x.sent_at),'[]'::jsonb) into v_messages
  from (
    select m.sent_at,jsonb_build_object(
      'message_id',m.message_id,'sent_at',m.sent_at,'direction',m.direction,
      'actor_type',m.actor_type,'actor_name',m.actor_name,'source_system',m.source_system,
      'is_automatic',m.is_automatic,'text',m.message_text,
      'has_attachments',public.v8_jsonb_has_attachments(m.attachments)
    ) obj
    from public.v8_messages_raw m
    where m.customer_id=p_customer_id
      and m.sent_at>=coalesce(v_anchor_at,now())-interval '24 hours'
      and m.sent_at<=coalesce(v_anchor_at,now())+interval '24 hours'
    order by m.sent_at desc
    limit 80
  ) x;

  select jsonb_build_object('message_id',m.message_id,'sent_at',m.sent_at,'direction',m.direction,'actor_type',m.actor_type,'source_system',m.source_system,'text',m.message_text)
    into v_last_message from public.v8_messages_raw m where m.customer_id=p_customer_id order by m.sent_at desc limit 1;
  select jsonb_build_object('message_id',m.message_id,'sent_at',m.sent_at,'text',m.message_text)
    into v_last_inbound from public.v8_messages_raw m where m.customer_id=p_customer_id and m.direction='inbound' order by m.sent_at desc limit 1;
  select jsonb_build_object('message_id',m.message_id,'sent_at',m.sent_at,'text',m.message_text,'actor_name',m.actor_name,'quality',public.v8_sale_reply_quality(m.message_text,m.attachments))
    into v_last_human from public.v8_messages_raw m
    where m.customer_id=p_customer_id and m.direction='outbound'
      and public.v8_is_actionable_external_outbound(m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail)
    order by m.sent_at desc limit 1;
  select jsonb_build_object('message_id',m.message_id,'sent_at',m.sent_at,'text',m.message_text)
    into v_last_bot from public.v8_messages_raw m
    where m.customer_id=p_customer_id and m.direction='outbound'
      and coalesce(m.source_system,'') in ('aiguka','aiguka_v8')
    order by m.sent_at desc limit 1;
  select count(*)::integer into v_slide_count from public.v8_slide_logs where customer_id=p_customer_id and send_status='sent';
  select count(*)::integer into v_phone_requests from public.v8_reply_plans where customer_id=p_customer_id and should_request_phone and sent_at is not null;

  return jsonb_build_object(
    'ok',true,'snapshot_version','v8_snapshot_v1','customer_id',c.id,
    'page_id',c.page_id,'sender_id',c.sender_id,'anchor_message_id',v_anchor,'anchor_at',v_anchor_at,
    'has_contact',coalesce(c.phone is not null or c.zalo is not null or s.has_phone,false),
    'phone',c.phone,'zalo',c.zalo,'lead_state',c.lead_state,
    'current_product_key',c.last_product_key,'current_catalog_key',c.last_catalog_key,
    'current_intent_type',c.last_intent_type,'stage',s.stage,
    'last_message',coalesce(v_last_message,'{}'::jsonb),
    'last_inbound',coalesce(v_last_inbound,'{}'::jsonb),
    'last_human',coalesce(v_last_human,'{}'::jsonb),
    'last_bot',coalesce(v_last_bot,'{}'::jsonb),
    'sent_slide_count',v_slide_count,'phone_request_count',v_phone_requests,
    'messages',v_messages
  );
end;
$function$;

create or replace function public.v8_apply_decision_snapshot_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_snapshot jsonb;
  v_snapshot_id uuid;
  v_last_inbound_id text;
begin
  if new.customer_id is null or nullif(new.message_id,'') is null then return new; end if;
  v_snapshot:=public.v8_build_conversation_snapshot(new.customer_id,new.message_id);
  if not coalesce((v_snapshot->>'ok')::boolean,false) then return new; end if;

  insert into public.v8_conversation_snapshots(customer_id,page_id,sender_id,anchor_message_id,anchor_at,snapshot,updated_at)
  values(new.customer_id,new.page_id,new.sender_id,new.message_id,nullif(v_snapshot->>'anchor_at','')::timestamptz,v_snapshot,now())
  on conflict(customer_id,anchor_message_id) do update set
    snapshot=excluded.snapshot,anchor_at=excluded.anchor_at,updated_at=now()
  returning id into v_snapshot_id;

  new.reason:=coalesce(new.reason,'{}'::jsonb)||jsonb_build_object(
    'conversation_snapshot_id',v_snapshot_id,
    'conversation_snapshot_version',v_snapshot->>'snapshot_version',
    'snapshot_has_contact',coalesce((v_snapshot->>'has_contact')::boolean,false),
    'snapshot_last_message_id',v_snapshot->'last_message'->>'message_id',
    'snapshot_last_direction',v_snapshot->'last_message'->>'direction'
  );

  v_last_inbound_id:=v_snapshot->'last_inbound'->>'message_id';
  if v_last_inbound_id is distinct from new.message_id and coalesce(new.dispatch_status,'not_staged')<>'sent' then
    new.send_eligible:=false;
    new.safety_status:='suppressed_superseded';
    new.blocked_reason:='snapshot_newer_customer_turn_exists';
    new.is_latest_customer_turn:=false;
    return new;
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
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_v8_ab_decision_snapshot_guard on public.v8_reply_plans;
create trigger trg_v8_ab_decision_snapshot_guard
before insert or update of customer_id,message_id,action_type,suggested_reply,send_eligible
on public.v8_reply_plans
for each row execute function public.v8_apply_decision_snapshot_guard();

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
  if v_norm ~ '(^| )(lua dao|khieu nai|that vong|te qua|kem chat luong|bi loi|hong|khong hai long|boc phot)( |$)' then
    return jsonb_build_object('lead_status','manual_review','lead_score',70,'reason','complaint_or_negative','intent_type','complaint','auto_private_reply',false);
  end if;

  if v_norm ~ '(^| )(gia|bao nhieu|bao gia|xin gia|ib|inbox|tu van|xin mau|xem mau|hinh anh|anh that|dia chi|o dau|con hang|ship|van chuyen|bao hanh|kich thuoc|mau nao|mua|dat hang)( |$)' then
    v_status:='qualified';v_score:=50;v_reason:='commercial_intent';v_private_reply:=true;
    v_intent:=case
      when v_norm ~ '(^| )(gia|bao nhieu|bao gia|xin gia)( |$)' then 'ask_price'
      when v_norm ~ '(^| )(xin mau|xem mau|hinh anh|anh that)( |$)' then 'ask_sample'
      when v_norm ~ '(^| )(dia chi|o dau)( |$)' then 'ask_address'
      when v_norm ~ '(^| )(con hang|mua|dat hang)( |$)' then 'ask_consult'
      else 'ask_consult' end;
  elsif char_length(v_norm)<=12 and v_norm in ('ib','inbox','tu van','gia','bao gia') then
    v_status:='qualified';v_score:=45;v_reason:='short_commercial_intent';v_private_reply:=true;v_intent:='ask_consult';
  elsif v_norm ~ '(^| )(dep|hay|ok|cam on|thank|like)( |$)' then
    v_status:='ignored';v_score:=0;v_reason:='social_only';
  end if;

  return jsonb_build_object(
    'lead_status',v_status,'lead_score',v_score,'reason',v_reason,
    'intent_type',v_intent,'detected_phone',v_phone,'auto_private_reply',v_private_reply
  );
end;
$function$;

create or replace function public.v8_register_comment_event(
  p_page_id text,
  p_comment_id text,
  p_parent_id text default null,
  p_post_id text default null,
  p_sender_id text default null,
  p_sender_name text default null,
  p_message_text text default null,
  p_event_time timestamptz default now(),
  p_verb text default null,
  p_item_type text default 'comment',
  p_raw_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_class jsonb;
  d record;
  i record;
  v_id uuid;
  v_source record;
  v_product_key text;
  v_catalog_key text;
  v_intent text;
begin
  if nullif(btrim(coalesce(p_page_id,'')),'') is null or nullif(btrim(coalesce(p_comment_id,'')),'') is null then
    return jsonb_build_object('ok',false,'reason','PAGE_OR_COMMENT_ID_MISSING');
  end if;
  v_class:=public.v8_classify_comment_lead(p_message_text,p_sender_id,p_page_id,p_raw_payload);
  begin select * into d from public.v8_detect_catalog_smart(coalesce(p_message_text,'')) limit 1; exception when others then d:=null; end;
  begin select * into i from public.v8_detect_intent_rule(coalesce(p_message_text,'')) limit 1; exception when others then i:=null; end;
  v_product_key:=d.root_product_key;
  v_catalog_key:=d.catalog_key;
  v_intent:=coalesce(v_class->>'intent_type',i.intent_type);

  select r.ad_id,r.product_key,r.post_id into v_source
  from public.v8_meta_ad_referral_entries r
  where r.page_id=p_page_id and r.post_id=p_post_id
  order by r.referral_at desc limit 1;
  v_product_key:=coalesce(v_product_key,v_source.product_key);

  insert into public.v8_comment_events(
    page_id,comment_id,parent_id,post_id,sender_id,sender_name,message_text,event_time,verb,item_type,
    ad_id,product_key,catalog_key,intent_type,lead_score,lead_status,classifier_reason,
    has_contact,detected_phone,private_reply_status,raw_payload,updated_at
  ) values(
    p_page_id,p_comment_id,p_parent_id,p_post_id,p_sender_id,p_sender_name,p_message_text,coalesce(p_event_time,now()),p_verb,p_item_type,
    v_source.ad_id,v_product_key,v_catalog_key,v_intent,coalesce((v_class->>'lead_score')::integer,0),coalesce(v_class->>'lead_status','ignored'),v_class,
    (v_class->>'detected_phone') is not null,v_class->>'detected_phone',
    case when coalesce((v_class->>'auto_private_reply')::boolean,false) then 'eligible' else 'not_planned' end,
    coalesce(p_raw_payload,'{}'::jsonb),now()
  )
  on conflict(page_id,comment_id) do update set
    parent_id=coalesce(excluded.parent_id,public.v8_comment_events.parent_id),
    post_id=coalesce(excluded.post_id,public.v8_comment_events.post_id),
    sender_id=coalesce(excluded.sender_id,public.v8_comment_events.sender_id),
    sender_name=coalesce(excluded.sender_name,public.v8_comment_events.sender_name),
    message_text=coalesce(excluded.message_text,public.v8_comment_events.message_text),
    event_time=least(public.v8_comment_events.event_time,excluded.event_time),
    ad_id=coalesce(excluded.ad_id,public.v8_comment_events.ad_id),
    product_key=coalesce(excluded.product_key,public.v8_comment_events.product_key),
    catalog_key=coalesce(excluded.catalog_key,public.v8_comment_events.catalog_key),
    intent_type=coalesce(excluded.intent_type,public.v8_comment_events.intent_type),
    lead_score=excluded.lead_score,lead_status=excluded.lead_status,classifier_reason=excluded.classifier_reason,
    has_contact=excluded.has_contact,detected_phone=coalesce(excluded.detected_phone,public.v8_comment_events.detected_phone),
    private_reply_status=case when public.v8_comment_events.private_reply_status in ('sent','queued','sending') then public.v8_comment_events.private_reply_status else excluded.private_reply_status end,
    raw_payload=public.v8_comment_events.raw_payload||excluded.raw_payload,updated_at=now()
  returning id into v_id;
  return jsonb_build_object('ok',true,'comment_event_id',v_id,'classification',v_class,'product_key',v_product_key,'catalog_key',v_catalog_key,'intent_type',v_intent);
end;
$function$;
