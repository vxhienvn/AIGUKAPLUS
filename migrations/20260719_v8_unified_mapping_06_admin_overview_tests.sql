create or replace function public.v8_admin_test_unified_mapping(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_result jsonb; v_ref jsonb; v_assets jsonb;
begin
  perform public.v8_assert_admin_request();
  v_ref:=jsonb_strip_nulls(jsonb_build_object('ad_id',nullif(p_payload->>'ad_id',''),'source','ADS','ads_context_data',jsonb_build_object('ad_title',nullif(p_payload->>'ad_title',''))));
  v_result:=public.v8_resolve_unified_mapping(nullif(p_payload->>'page_id',''),coalesce(nullif(p_payload->>'sender_id',''),'mapping_test'),coalesce(p_payload->>'message_text',''),v_ref,now());
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_assets from (
    select id,catalog_key,product_key,parent_folder_id,parent_folder_name,file_name,coalesce(nullif(delivery_url,''),file_url) url
    from public.v8_drive_assets a
    where a.is_active and a.is_image and (
      a.catalog_key=nullif(v_result->>'catalog_key','')
      or a.parent_folder_id=any(public.v8_mapping_folder_ids(v_result->'slide_folder_ids'))
    ) order by case when a.catalog_key=nullif(v_result->>'catalog_key','') then 0 else 1 end,a.sort_order,a.file_name limit 10
  ) x;
  return jsonb_build_object('resolution',v_result,'asset_preview',v_assets,'would_send_slide',coalesce(jsonb_array_length(v_assets),0)>0 and coalesce(p_payload->>'intent_type','ask_sample')='ask_sample');
end;
$function$;

create or replace function public.v8_admin_mapping_overview()
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
begin
  perform public.v8_assert_admin_request();
  return jsonb_build_object(
    'runtime',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('page_name',p.page_name) order by p.page_name) from public.v8_mapping_runtime r join public.v8_pages p using(page_id)),'[]'::jsonb),
    'ad_mappings',coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at desc) from (select * from public.ad_mappings order by updated_at desc limit 1000) x),'[]'::jsonb),
    'unmapped_ads',coalesce((select jsonb_agg(to_jsonb(x) order by x.last_date desc,x.conversations desc) from (select * from public.v8_unmapped_ad_summary order by last_date desc,conversations desc limit 500) x),'[]'::jsonb),
    'coverage',(select to_jsonb(x) from public.v8_ad_mapping_coverage x),
    'groups',coalesce((select jsonb_agg(to_jsonb(g) order by g.priority,g.group_name) from public.v8_business_product_groups g where g.is_active),'[]'::jsonb),
    'catalogs',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('group_key',(select group_key from public.v8_resolve_business_group(c.catalog_key) limit 1),'image_count',(select count(*) from public.v8_drive_assets a where a.catalog_key=c.catalog_key and a.is_active and a.is_image)) order by c.catalog_name) from public.v8_product_catalog c where c.is_active),'[]'::jsonb),
    'slide_mappings',coalesce((select jsonb_agg(to_jsonb(sm)||jsonb_build_object('image_count',(select count(*) from public.v8_drive_assets a where a.is_active and a.is_image and (a.product_key=sm.product_key or a.parent_folder_id=any(public.v8_mapping_folder_ids(sm.drive_folder_ids))))) order by sm.priority,sm.product_name) from public.v8_slide_mapping sm),'[]'::jsonb),
    'asset_summary',coalesce((select jsonb_agg(to_jsonb(x) order by x.active_images desc) from (select product_key,catalog_key,count(*) filter(where is_active and is_image) active_images,count(*) filter(where delivery_status='verified') verified,count(*) filter(where delivery_status='error') errors,max(last_seen_at) last_seen from public.v8_drive_assets group by product_key,catalog_key) x),'[]'::jsonb),
    'change_log',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (select * from public.v8_admin_change_log where action like '%mapping%' order by created_at desc limit 100) x),'[]'::jsonb)
  );
end;
$function$;

create or replace function public.v8_mapping_regression_test()
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare a jsonb; b jsonb; c jsonb; d jsonb; passed integer:=0;
begin
  a:=public.v8_resolve_unified_mapping('104810069068200','test_a','Cho mình xem mẫu chậu rửa phòng bếp','{"ad_id":"x","ads_context_data":{"ad_title":"Tổng hợp khuyến mại"}}'::jsonb,now());
  b:=public.v8_resolve_unified_mapping('104810069068200','test_b','Gửi mẫu cho tôi','{"ads_context_data":{"ad_title":"Quạt trần 10 cánh mạ vàng"}}'::jsonb,now());
  c:=public.v8_resolve_unified_mapping('104810069068200','test_c','Tôi cần bồn cầu thông minh','{"ads_context_data":{"ad_title":"Quạt trần 10 cánh"}}'::jsonb,now());
  d:=public.v8_resolve_unified_mapping('104810069068200','test_d','Gửi mẫu cho tôi','{"ads_context_data":{"ad_title":"Tổng hợp khuyến mại"}}'::jsonb,now());
  passed:=passed+(case when a->>'catalog_key'='chau_voi_rua_bat' then 1 else 0 end)+(case when b->>'group_key'='quat_10_canh' or b->>'catalog_key' like 'quat_10_canh%' then 1 else 0 end)+(case when c->>'group_key'='bon_cau' and coalesce((c->>'conflict')::boolean,false) then 1 else 0 end)+(case when d->>'status' in ('unknown','scope_only') and coalesce((d->>'needs_clarification')::boolean,true) then 1 else 0 end);
  return jsonb_build_object('passed',passed,'total',4,'status',case when passed=4 then 'passed' else 'failed' end,'cases',jsonb_build_array(jsonb_build_object('case','explicit_kitchen_sink','passed',a->>'catalog_key'='chau_voi_rua_bat','result',a),jsonb_build_object('case','ad_title_quat_10_canh','passed',b->>'group_key'='quat_10_canh' or b->>'catalog_key' like 'quat_10_canh%','result',b),jsonb_build_object('case','customer_overrides_ad','passed',c->>'group_key'='bon_cau' and coalesce((c->>'conflict')::boolean,false),'result',c),jsonb_build_object('case','generic_ad_clarifies','passed',d->>'status' in ('unknown','scope_only') and coalesce((d->>'needs_clarification')::boolean,true),'result',d)));
end;
$function$;

comment on function public.v8_resolve_unified_mapping(text,text,text,jsonb,timestamptz) is 'Single mapping decision shared by product detection, reply planning and slide routing. Customer wording overrides ad mapping; generic ads never force a product.';
comment on table public.v8_mapping_runtime is 'Per-page OFF/OBSERVE/ACTIVE switch for the unified mapping resolver.';
