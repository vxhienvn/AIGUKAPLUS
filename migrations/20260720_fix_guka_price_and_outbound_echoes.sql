-- Preserve AI authority for non-numeric price explanations and correctly classify
-- text/image messages echoed back by the Meta Conversations API.

create or replace function public.v8_ai_normalize_completed_decision()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_norm text;
  v_price_context boolean;
  v_sample_requested boolean;
  v_numeric_price_claim boolean;
  v_has_verified_price_evidence boolean;
  v_missing_verified_price_signal boolean;
  v_base jsonb:='[]'::jsonb;
begin
  if new.status <> 'completed' then return new; end if;

  select coalesce(jsonb_agg(e.value),'[]'::jsonb)
    into v_base
  from jsonb_array_elements(coalesce(new.rule_advisories,'[]'::jsonb)) e(value)
  where coalesce(e.value->>'source','') not in ('price_safety_rule','slide_support_rule');
  new.rule_advisories:=coalesce(v_base,'[]'::jsonb);

  v_norm:=public.v8_normalize_detector_text(concat_ws(' ',new.customer_goal,new.intent_type,new.product_scope,new.catalog_key,new.final_reply));
  v_price_context:=v_norm ~ '(gia|bao gia|ngan sach|tam gia|muc gia|trieu|nghin|vnd)';
  v_numeric_price_claim:=coalesce(new.final_reply,'') ~* '[0-9][0-9., ]*(triệu|trieu|nghìn|nghin|vnd|₫|đ)';
  v_has_verified_price_evidence:=coalesce(new.evidence_summary,'[]'::jsonb)::text ~* '(verified_price|price_range|ad_mappings.price_range|gia xac thuc|giá xác thực)';
  v_missing_verified_price_signal:=coalesce(new.risk_flags,'[]'::jsonb)::text ~* '(price_not_checked|unverified_price|price_unverified|exact_price|price_missing|no_verified_price|price_source_missing)';

  if v_numeric_price_claim and not v_has_verified_price_evidence then
    new.rule_advisories:=new.rule_advisories||jsonb_build_array(jsonb_build_object(
      'source','price_safety_rule','severity','block','recommended_action','ai_regenerate',
      'reason','NUMERIC_PRICE_REQUIRES_VERIFIED_EVIDENCE','may_modify_ai_reply',false
    ));
  elsif v_price_context and v_missing_verified_price_signal then
    new.rule_advisories:=new.rule_advisories||jsonb_build_array(jsonb_build_object(
      'source','price_safety_rule','severity','warning','recommended_action','allow_ai_non_numeric_price_explanation',
      'reason','NO_VERIFIED_PRICE_NON_NUMERIC_REPLY_ALLOWED','may_modify_ai_reply',false
    ));
  end if;

  v_sample_requested:=coalesce(new.should_send_slide,false)
    or v_norm ~ '(xem|gui|cho xem).*(mau|hinh|catalog|slide)'
    or v_norm ~ '(mau|hinh|catalog|slide).*(xem|gui)'
    or lower(coalesce(new.intent_type,'')) ~ '(sample|browse)';

  if v_sample_requested and jsonb_array_length(coalesce(new.slide_asset_ids,'[]'::jsonb))=0 then
    new.rule_advisories:=new.rule_advisories||jsonb_build_array(jsonb_build_object(
      'source','slide_support_rule','severity','warning','recommended_action','ai_review_slide_decision',
      'reason','SLIDE_CONTEXT_WITHOUT_VERIFIED_ASSET','may_modify_ai_reply',false
    ));
  end if;
  return new;
end;
$function$;

create or replace function public.v8_is_own_outbound_event(
  p_customer_id uuid,
  p_message_text text,
  p_attachments jsonb,
  p_event_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
select exists(
  select 1
  from public.v8_outbound_queue q
  where q.customer_id=p_customer_id
    and q.status in ('sending','sent')
    and coalesce(q.transport_confirmed_at,q.sent_at,q.updated_at)
        between coalesce(p_event_at,now())-interval '5 minutes'
            and coalesce(p_event_at,now())+interval '5 minutes'
    and (
      (q.message_type='text'
       and nullif(btrim(coalesce(p_message_text,'')),'') is not null
       and public.v8_reply_fingerprint(q.payload->>'text')=public.v8_reply_fingerprint(p_message_text))
      or
      (q.message_type='image'
       and public.v8_jsonb_has_attachments(coalesce(p_attachments,'[]'::jsonb))
       and coalesce(q.transport_confirmed_at,q.sent_at,q.updated_at)
           between coalesce(p_event_at,now())-interval '90 seconds'
               and coalesce(p_event_at,now())+interval '90 seconds')
    )
);
$function$;

create or replace function public.v8_mark_own_outbound_before_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.direction='outbound'
     and new.customer_id is not null
     and exists (
       select 1
       from public.v8_outbound_queue q
       where q.customer_id=new.customer_id
         and q.message_type='text'
         and q.status='sent'
         and q.sent_at between coalesce(new.sent_at,new.created_at,now())-interval '5 minutes'
                           and coalesce(new.sent_at,new.created_at,now())+interval '5 minutes'
         and public.v8_reply_fingerprint(q.payload->>'text')=public.v8_reply_fingerprint(new.message_text)
     ) then
    new.actor_type='bot';
    new.actor_name='AIGUKA';
    new.source_system='aiguka_v8';
    new.is_automatic=true;
    new.actor_confidence='matched_sent_outbound';
    new.source_detail=coalesce(new.source_detail,'{}'::jsonb)||jsonb_build_object('classification','aiguka_sent_outbound');
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_v8_000_mark_own_outbound on public.v8_messages_raw;
create trigger trg_v8_000_mark_own_outbound
before insert or update of direction,message_text,source_system,is_automatic,actor_type
on public.v8_messages_raw
for each row execute function public.v8_mark_own_outbound_before_write();

create or replace function public.v8_mark_own_image_echo_before_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.direction='outbound'
     and new.customer_id is not null
     and public.v8_jsonb_has_attachments(coalesce(new.attachments,'[]'::jsonb))
     and public.v8_is_own_outbound_event(new.customer_id,null,new.attachments,coalesce(new.sent_at,new.created_at,now())) then
    new.actor_type:='bot';
    new.actor_name:='AIGUKA';
    new.source_system:='aiguka_v8';
    new.is_automatic:=true;
    new.actor_confidence:='matched_aiguka_image_transport';
    new.source_detail:=coalesce(new.source_detail,'{}'::jsonb)||jsonb_build_object('classification','aiguka_image_transport_echo');
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_v8_000_mark_own_image_echo on public.v8_messages_raw;
create trigger trg_v8_000_mark_own_image_echo
before insert or update of direction,attachments,source_system,is_automatic,actor_type
on public.v8_messages_raw
for each row execute function public.v8_mark_own_image_echo_before_write();
