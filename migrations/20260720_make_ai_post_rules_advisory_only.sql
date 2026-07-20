create or replace function public.v8_ai_normalize_completed_decision()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_norm text;
  v_price_context boolean;
  v_price_risk boolean;
  v_sample_requested boolean;
  v_numeric_price_claim boolean;
  v_has_verified_price_evidence boolean;
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
  v_price_risk:=
    (v_price_context and coalesce(new.risk_flags,'[]'::jsonb)::text ~* '(price_not_checked|unverified_price|price_unverified|exact_price|price_missing|no_verified_price|price_source_missing)')
    or (v_numeric_price_claim and not v_has_verified_price_evidence);

  if v_price_risk then
    new.rule_advisories:=new.rule_advisories||jsonb_build_array(jsonb_build_object(
      'source','price_safety_rule','severity','block','recommended_action','ai_regenerate',
      'reason','PRICE_CLAIM_REQUIRES_VERIFIED_EVIDENCE','may_modify_ai_reply',false
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
$$;

create or replace function public.v8_guard_ai_output()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_norm text;
  v_base jsonb:='[]'::jsonb;
begin
  if new.status<>'completed' or not coalesce(new.should_reply,false) then return new; end if;

  select coalesce(jsonb_agg(e.value),'[]'::jsonb)
    into v_base
  from jsonb_array_elements(coalesce(new.rule_advisories,'[]'::jsonb)) e(value)
  where coalesce(e.value->>'source','')<>'inventory_claim_rule';
  new.rule_advisories:=coalesce(v_base,'[]'::jsonb);

  v_norm:=public.v8_normalize_detector_text(coalesce(new.final_reply,''));
  if position('co san' in v_norm)>0
     or position('con hang' in v_norm)>0
     or position('san hang' in v_norm)>0
     or position('giao ngay' in v_norm)>0 then
    new.rule_advisories:=new.rule_advisories||jsonb_build_array(jsonb_build_object(
      'source','inventory_claim_rule','severity','block','recommended_action','ai_regenerate',
      'reason','UNVERIFIED_INVENTORY_OR_DELIVERY_CLAIM','may_modify_ai_reply',false
    ));
  end if;
  return new;
end;
$$;