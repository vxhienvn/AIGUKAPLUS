-- Prefer the most specific product alias before a broad parent alias.
create or replace function public.v8_detect_catalog_smart(input_text text)
returns table(catalog_key text,catalog_name text,root_product_key text,matched_alias text,match_method text,confidence numeric,decision text,folder_path text)
language sql stable set search_path to 'public'
as $function$
with n as (select public.v8_normalize_detector_text(input_text) txt), exact_match as (
 select c.catalog_key,c.catalog_name,c.root_product_key,a.alias,'exact_alias'::text method,greatest(0.82,least(0.99,a.confidence/100.0))::numeric score,c.folder_path,a.priority,length(a.normalized_alias) alias_len
 from n join public.v8_product_aliases a on a.is_active and (' '||n.txt||' ') like '% '||btrim(a.normalized_alias)||' %'
 join public.v8_product_catalog c on c.catalog_key=a.catalog_key and c.is_active
 order by alias_len desc,a.priority asc,score desc limit 1
), fuzzy_match as (
 select c.catalog_key,c.catalog_name,c.root_product_key,a.alias,'fuzzy_alias'::text method,similarity(n.txt,a.normalized_alias)::numeric score,c.folder_path,a.priority,length(a.normalized_alias) alias_len
 from n join public.v8_product_aliases a on a.is_active join public.v8_product_catalog c on c.catalog_key=a.catalog_key and c.is_active
 where similarity(n.txt,a.normalized_alias)>=coalesce((select (setting_value#>>'{}')::numeric from public.v8_detector_settings where setting_key='fuzzy_min_similarity'),0.52)
 order by score desc,alias_len desc,a.priority asc limit 1
), chosen as (
 select * from exact_match union all select * from fuzzy_match where not exists(select 1 from exact_match) limit 1
)
select catalog_key,catalog_name,root_product_key,alias,method,score,
 case when score>=coalesce((select (setting_value#>>'{}')::numeric from public.v8_detector_settings where setting_key='high_confidence_threshold'),0.82) then 'auto'
 when score>=coalesce((select (setting_value#>>'{}')::numeric from public.v8_detector_settings where setting_key='medium_confidence_threshold'),0.62) then 'confirm_or_parent' else 'no_action' end,
 folder_path from chosen;
$function$;

insert into public.v8_product_aliases(catalog_key,alias,normalized_alias,priority,confidence,source,is_active,updated_at)
values
 ('quat_10_canh','quạt trần 10 cánh','quat tran 10 canh',1,99,'unified_mapping_v1',true,now()),
 ('quat_10_canh_gold','quạt trần 10 cánh mạ vàng','quat tran 10 canh ma vang',1,99,'unified_mapping_v1',true,now()),
 ('quat_10_canh_gold','quạt 10 cánh mạ vàng','quat 10 canh ma vang',1,99,'unified_mapping_v1',true,now()),
 ('quat_8_canh','quạt trần 8 cánh','quat tran 8 canh',1,99,'unified_mapping_v1',true,now()),
 ('quat_5_6_canh','quạt trần 5 cánh','quat tran 5 canh',1,99,'unified_mapping_v1',true,now()),
 ('quat_5_6_canh','quạt trần 6 cánh','quat tran 6 canh',1,99,'unified_mapping_v1',true,now())
on conflict(catalog_key,normalized_alias) do update set alias=excluded.alias,priority=least(v8_product_aliases.priority,excluded.priority),confidence=greatest(v8_product_aliases.confidence,excluded.confidence),source=excluded.source,is_active=true,updated_at=now();

grant select on public.v8_mapping_runtime,public.v8_mapping_key_aliases to anon,authenticated,service_role;
grant execute on function public.v8_resolve_unified_mapping(text,text,text,jsonb,timestamptz),public.v8_mapping_regression_test(),public.v8_admin_mapping_overview(),public.v8_admin_test_unified_mapping(jsonb),public.v8_admin_save_ad_mapping(jsonb),public.v8_admin_set_mapping_runtime(jsonb),public.v8_admin_disable_ad_mapping(text,text),public.v8_admin_save_slide_mapping(jsonb) to anon,authenticated,service_role;
