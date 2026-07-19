create or replace function public.v8_catalog_descendant_keys(p_catalog_key text)
returns table(catalog_key text)
language sql stable set search_path to 'public'
as $function$
with recursive tree as (
  select c.catalog_key from public.v8_product_catalog c where c.catalog_key=p_catalog_key and c.is_active
  union all
  select c.catalog_key from public.v8_product_catalog c join tree t on c.parent_key=t.catalog_key where c.is_active
)
select distinct tree.catalog_key from tree;
$function$;

insert into public.v8_mapping_key_aliases(alias_key,canonical_group_key,catalog_key,root_product_key,alias_type,note)
values
 ('fan','quat_tran','quat_tran_den_chum_decor','quat_tran_den_chum_decor','legacy','Legacy fan group'),
 ('bathtub','bon_tam','bon_tam','bon_tam','legacy','Legacy bathtub group'),
 ('kitchen','bep_tu_hut_mui','bep_tu_hut_mui','bep_tu_hut_mui','legacy','Legacy kitchen group')
on conflict(alias_key) do update set canonical_group_key=excluded.canonical_group_key,catalog_key=excluded.catalog_key,root_product_key=excluded.root_product_key,alias_type=excluded.alias_type,is_active=true,note=excluded.note,updated_at=now();

update public.v8_mapping_key_aliases
set root_product_key='quat_tran_den_chum_decor',updated_at=now()
where alias_key in ('quat_tran_decor','quat_tran_den_chum_decor','quat_tran','quat_10_canh','quat_8_canh','quat_5_6_canh','den_trum');

grant execute on function public.v8_catalog_descendant_keys(text) to anon,authenticated,service_role;
