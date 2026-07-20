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
  v_assets jsonb;
  v_lookup_key text;
  v_numeric_price_claim boolean;
  v_has_verified_price_evidence boolean;
begin
  if new.status <> 'completed' then return new; end if;

  v_norm := public.v8_normalize_detector_text(concat_ws(' ',new.customer_goal,new.intent_type,new.product_scope,new.catalog_key,new.final_reply));
  v_price_context := v_norm ~ '(gia|bao gia|ngan sach|tam gia|muc gia|trieu|nghin|vnd)';
  v_numeric_price_claim := coalesce(new.final_reply,'') ~* '[0-9][0-9., ]*(triệu|trieu|nghìn|nghin|vnd|₫|đ)';
  v_has_verified_price_evidence := coalesce(new.evidence_summary,'[]'::jsonb)::text ~* '(verified_price|price_range|ad_mappings.price_range|gia xac thuc|giá xác thực)';

  v_price_risk :=
    (v_price_context and coalesce(new.risk_flags,'[]'::jsonb)::text ~* '(price_not_checked|unverified_price|price_unverified|exact_price|price_missing|no_verified_price|price_source_missing)')
    or (v_price_context and (not coalesce(new.should_reply,false) or btrim(coalesce(new.final_reply,''))=''))
    or (v_numeric_price_claim and not v_has_verified_price_evidence);

  v_sample_requested := coalesce(new.should_send_slide,false)
    or v_norm ~ '(xem|gui|cho xem).*(mau|hinh|catalog|slide)'
    or v_norm ~ '(mau|hinh|catalog|slide).*(xem|gui)'
    or lower(coalesce(new.intent_type,'')) ~ '(sample|browse)';

  if v_price_risk then
    if v_sample_requested then
      new.final_reply := 'Dạ sản phẩm này có nhiều mức giá tùy mẫu, thương hiệu và cấu hình ạ. Em gửi anh/chị một số mẫu phù hợp để tham khảo trước; anh/chị để lại SĐT hoặc Zalo, bên em báo giá và tư vấn cụ thể cho mình nhé.';
    else
      new.final_reply := 'Dạ sản phẩm này có nhiều mức giá tùy mẫu, thương hiệu và cấu hình ạ. Anh/chị để lại SĐT hoặc Zalo, bên em tư vấn cụ thể và báo giá phù hợp cho mình nhé.';
    end if;
    new.should_reply := true;
    new.should_request_contact := true;
    new.should_handoff_sale := false;
    new.risk_flags := coalesce(new.risk_flags,'[]'::jsonb) || '["price_fallback_applied"]'::jsonb;
    new.decision := coalesce(new.decision,'{}'::jsonb) || jsonb_build_object(
      'should_reply',true,'final_reply',new.final_reply,'should_request_contact',true,
      'should_handoff_sale',false,'price_fallback_applied',true
    );
  end if;

  if v_sample_requested and jsonb_array_length(coalesce(new.slide_asset_ids,'[]'::jsonb))=0 then
    v_lookup_key := coalesce(nullif(new.catalog_key,''),nullif(new.product_scope,''));
    if v_lookup_key is not null then
      with descendants as (
        select x.catalog_key from public.v8_catalog_descendant_keys(v_lookup_key) x
      ), selected as (
        select a.id from public.v8_drive_assets a
        where a.is_active and a.is_image
          and coalesce(a.delivery_status,'verified') <> 'error'
          and (a.catalog_key=new.catalog_key or a.catalog_key=new.product_scope or a.product_key=new.product_scope or a.catalog_key in (select catalog_key from descendants))
        order by case when coalesce(a.parent_folder_name,'') ilike '%bán chạy%' or coalesce(a.parent_folder_name,'') ilike '%ban chay%' then 0 else 1 end,
          a.sort_order nulls last,a.id
        limit 6
      )
      select coalesce(jsonb_agg(to_jsonb(id::text)),'[]'::jsonb) into v_assets from selected;
      if jsonb_array_length(v_assets)>0 then
        new.should_send_slide:=true;
        new.slide_asset_ids:=v_assets;
        new.decision:=coalesce(new.decision,'{}'::jsonb)||jsonb_build_object('should_send_slide',true,'slide_asset_ids',v_assets,'slide_selected_by','exact_catalog_safety');
      end if;
    end if;
  end if;
  return new;
end;
$$;