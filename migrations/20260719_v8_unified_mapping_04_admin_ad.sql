create or replace function public.v8_admin_save_ad_mapping(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ad_id text:=nullif(btrim(p_payload->>'ad_id'),'');
  v_before jsonb; v_after jsonb; v_account_name text;
begin
  perform public.v8_assert_admin_request();
  if v_ad_id is null then raise exception 'missing_ad_id'; end if;
  select to_jsonb(m) into v_before from public.ad_mappings m where m.ad_id=v_ad_id;
  select ad_account_name into v_account_name from public.v8_meta_ad_accounts where ad_account_id=nullif(btrim(p_payload->>'ad_account_id'),'');
  insert into public.ad_mappings(
    ad_id,ad_name,ad_account_id,ad_account_name,campaign_id,campaign_name,adset_id,adset_name,
    product_type,product_name,product_group,product_item_key,recognition_name,carousel_key,slide_key,
    drive_folder,main_folder,product_drive_path,drive_folders,selected_folders,image_urls,price_range,zalo_url,
    effective_status,enabled,is_active,mapping_target_type,mapping_mode,notes
  ) values(
    v_ad_id,nullif(btrim(p_payload->>'ad_name'),''),nullif(btrim(p_payload->>'ad_account_id'),''),coalesce(nullif(btrim(p_payload->>'ad_account_name'),''),v_account_name),
    nullif(btrim(p_payload->>'campaign_id'),''),nullif(btrim(p_payload->>'campaign_name'),''),nullif(btrim(p_payload->>'adset_id'),''),nullif(btrim(p_payload->>'adset_name'),''),
    nullif(btrim(p_payload->>'product_type'),''),nullif(btrim(p_payload->>'product_name'),''),nullif(btrim(p_payload->>'product_group'),''),nullif(btrim(p_payload->>'product_item_key'),''),nullif(btrim(p_payload->>'recognition_name'),''),nullif(btrim(p_payload->>'carousel_key'),''),nullif(btrim(p_payload->>'slide_key'),''),
    nullif(btrim(p_payload->>'drive_folder'),''),nullif(btrim(p_payload->>'main_folder'),''),nullif(btrim(p_payload->>'product_drive_path'),''),coalesce(p_payload->'drive_folders','[]'::jsonb),coalesce(p_payload->'selected_folders','[]'::jsonb),coalesce(p_payload->'image_urls','[]'::jsonb),nullif(btrim(p_payload->>'price_range'),''),nullif(btrim(p_payload->>'zalo_url'),''),
    coalesce(nullif(btrim(p_payload->>'effective_status'),''),'UNKNOWN'),coalesce((p_payload->>'enabled')::boolean,true),coalesce((p_payload->>'is_active')::boolean,true),coalesce(nullif(btrim(p_payload->>'mapping_target_type'),''),'group'),coalesce(nullif(btrim(p_payload->>'mapping_mode'),''),'manual'),nullif(btrim(p_payload->>'notes'),'')
  ) on conflict(ad_id) do update set
    ad_name=case when p_payload?'ad_name' then nullif(btrim(p_payload->>'ad_name'),'') else ad_mappings.ad_name end,
    ad_account_id=case when p_payload?'ad_account_id' then nullif(btrim(p_payload->>'ad_account_id'),'') else ad_mappings.ad_account_id end,
    ad_account_name=case when p_payload?'ad_account_name' or p_payload?'ad_account_id' then coalesce(nullif(btrim(p_payload->>'ad_account_name'),''),v_account_name) else ad_mappings.ad_account_name end,
    campaign_id=case when p_payload?'campaign_id' then nullif(btrim(p_payload->>'campaign_id'),'') else ad_mappings.campaign_id end,
    campaign_name=case when p_payload?'campaign_name' then nullif(btrim(p_payload->>'campaign_name'),'') else ad_mappings.campaign_name end,
    adset_id=case when p_payload?'adset_id' then nullif(btrim(p_payload->>'adset_id'),'') else ad_mappings.adset_id end,
    adset_name=case when p_payload?'adset_name' then nullif(btrim(p_payload->>'adset_name'),'') else ad_mappings.adset_name end,
    product_type=case when p_payload?'product_type' then nullif(btrim(p_payload->>'product_type'),'') else ad_mappings.product_type end,
    product_name=case when p_payload?'product_name' then nullif(btrim(p_payload->>'product_name'),'') else ad_mappings.product_name end,
    product_group=case when p_payload?'product_group' then nullif(btrim(p_payload->>'product_group'),'') else ad_mappings.product_group end,
    product_item_key=case when p_payload?'product_item_key' then nullif(btrim(p_payload->>'product_item_key'),'') else ad_mappings.product_item_key end,
    recognition_name=case when p_payload?'recognition_name' then nullif(btrim(p_payload->>'recognition_name'),'') else ad_mappings.recognition_name end,
    carousel_key=case when p_payload?'carousel_key' then nullif(btrim(p_payload->>'carousel_key'),'') else ad_mappings.carousel_key end,
    slide_key=case when p_payload?'slide_key' then nullif(btrim(p_payload->>'slide_key'),'') else ad_mappings.slide_key end,
    drive_folder=case when p_payload?'drive_folder' then nullif(btrim(p_payload->>'drive_folder'),'') else ad_mappings.drive_folder end,
    main_folder=case when p_payload?'main_folder' then nullif(btrim(p_payload->>'main_folder'),'') else ad_mappings.main_folder end,
    product_drive_path=case when p_payload?'product_drive_path' then nullif(btrim(p_payload->>'product_drive_path'),'') else ad_mappings.product_drive_path end,
    drive_folders=case when p_payload?'drive_folders' then coalesce(p_payload->'drive_folders','[]'::jsonb) else ad_mappings.drive_folders end,
    selected_folders=case when p_payload?'selected_folders' then coalesce(p_payload->'selected_folders','[]'::jsonb) else ad_mappings.selected_folders end,
    image_urls=case when p_payload?'image_urls' then coalesce(p_payload->'image_urls','[]'::jsonb) else ad_mappings.image_urls end,
    price_range=case when p_payload?'price_range' then nullif(btrim(p_payload->>'price_range'),'') else ad_mappings.price_range end,
    zalo_url=case when p_payload?'zalo_url' then nullif(btrim(p_payload->>'zalo_url'),'') else ad_mappings.zalo_url end,
    effective_status=case when p_payload?'effective_status' then nullif(btrim(p_payload->>'effective_status'),'') else ad_mappings.effective_status end,
    enabled=case when p_payload?'enabled' then (p_payload->>'enabled')::boolean else ad_mappings.enabled end,
    is_active=case when p_payload?'is_active' then (p_payload->>'is_active')::boolean else ad_mappings.is_active end,
    mapping_target_type=case when p_payload?'mapping_target_type' then nullif(btrim(p_payload->>'mapping_target_type'),'') else ad_mappings.mapping_target_type end,
    mapping_mode=case when p_payload?'mapping_mode' then nullif(btrim(p_payload->>'mapping_mode'),'') else ad_mappings.mapping_mode end,
    notes=case when p_payload?'notes' then nullif(btrim(p_payload->>'notes'),'') else ad_mappings.notes end,
    updated_at=now()
  returning to_jsonb(ad_mappings.*) into v_after;
  insert into public.v8_admin_change_log(actor,action,asset_type,asset_id,before_data,after_data)
  values(coalesce(nullif(p_payload->>'actor',''),'admin_ui'),'save_ad_mapping','ad',v_ad_id,coalesce(v_before,'{}'::jsonb),v_after);
  return v_after;
end;
$function$;
