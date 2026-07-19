-- Unified Mapping Center for AIGUKA V8
-- Restores the V7 mapping role: ad -> product group -> product/catalog -> Drive assets -> slide.
-- No historical messages are replayed or requeued.

create table if not exists public.v8_mapping_runtime (
  page_id text primary key references public.v8_pages(page_id) on delete cascade,
  mode text not null default 'OBSERVE' check (mode in ('OFF','OBSERVE','ACTIVE')),
  use_ad_mapping boolean not null default true,
  use_recent_context boolean not null default true,
  use_slide_mapping boolean not null default true,
  minimum_apply_confidence numeric not null default 0.78 check (minimum_apply_confidence between 0 and 1),
  recent_context_minutes integer not null default 60 check (recent_context_minutes between 5 and 1440),
  updated_by text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.v8_mapping_runtime(page_id,mode,updated_by)
select page_id,'ACTIVE','migration_20260719'
from public.v8_pages
where is_active
on conflict(page_id) do nothing;

create table if not exists public.v8_mapping_key_aliases (
  alias_key text primary key,
  canonical_group_key text,
  catalog_key text,
  root_product_key text,
  alias_type text not null default 'legacy',
  is_active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.v8_mapping_key_aliases(alias_key,canonical_group_key,catalog_key,root_product_key,alias_type,note)
values
 ('combo_phong_tam','combo_phong_tam','combo_phong_tam_ve_sinh','combo_phong_tam_ve_sinh','canonical','Combo phòng tắm'),
 ('combo_phong_tam_ve_sinh','combo_phong_tam','combo_phong_tam_ve_sinh','combo_phong_tam_ve_sinh','legacy','Legacy root product'),
 ('bon_cau','bon_cau','bon_cau','bon_cau','canonical','Bồn cầu'),
 ('bon_tam','bon_tam','bon_tam','bon_tam','canonical','Bồn tắm'),
 ('sen_tam','sen_tam','sen_cay','sen_cay','canonical','Sen tắm'),
 ('sen_cay','sen_tam','sen_cay','sen_cay','legacy','Sen cây'),
 ('sen_c_y','sen_tam','sen_cay','sen_cay','legacy_typo','Malformed legacy key'),
 ('lavabo','lavabo_tu_lavabo','lavabo','lavabo','canonical','Lavabo'),
 ('lavabo_tu_lavabo','lavabo_tu_lavabo','lavabo','lavabo','legacy','Lavabo/tủ lavabo'),
 ('guong_tu','lavabo_tu_lavabo','guong_tu','guong_tu','canonical','Gương tủ'),
 ('bep_tu_hut_mui','bep_tu_hut_mui','bep_tu_hut_mui','bep_tu_hut_mui','canonical','Bếp từ/hút mùi tổng hợp'),
 ('bep_tu','bep_tu','bep_tu_hut_mui','bep_tu_hut_mui','canonical','Bếp từ'),
 ('may_hut_mui','may_hut_mui','bep_tu_hut_mui','bep_tu_hut_mui','canonical','Máy hút mùi'),
 ('chau_voi_rua_bat','chau_voi_rua_bat','chau_voi_rua_bat','chau_voi_rua_bat','canonical','Chậu/vòi rửa bát'),
 ('quat_tran_decor','quat_tran_den_chum_decor','quat_tran_den_chum_decor','quat_tran_decor','legacy','Quạt trần decor'),
 ('quat_tran_den_chum_decor','quat_tran_den_chum_decor','quat_tran_den_chum_decor','quat_tran_decor','canonical','Quạt/đèn decor'),
 ('quat_tran','quat_tran','quat_tran_den_chum_decor','quat_tran_decor','canonical','Quạt trần'),
 ('quat_10_canh','quat_10_canh','quat_10_canh','quat_tran_decor','canonical','Quạt 10 cánh'),
 ('quat_8_canh','quat_8_canh','quat_8_canh','quat_tran_decor','canonical','Quạt 8 cánh'),
 ('quat_5_6_canh','quat_5_6_canh','quat_5_6_canh','quat_tran_decor','canonical','Quạt 5-6 cánh'),
 ('den_trum','den_trum','den_trum','quat_tran_decor','canonical','Đèn trùm'),
 ('gach_ngoi','gach_da_op_lat','gach_ngoi','gach_ngoi','legacy','Gạch ngói'),
 ('gach_da_op_lat','gach_da_op_lat','gach_ngoi','gach_ngoi','canonical','Gạch đá ốp lát'),
 ('g_ch_ng_i','gach_da_op_lat','gach_ngoi','gach_ngoi','legacy_typo','Malformed legacy key'),
 ('phu_kien','phu_kien','phu_kien','phu_kien','canonical','Phụ kiện'),
 ('general',null,null,null,'scope','Quảng cáo tổng hợp, không ép sản phẩm'),
 ('unknown',null,null,null,'scope','Chưa rõ sản phẩm')
on conflict(alias_key) do update set
 canonical_group_key=excluded.canonical_group_key,
 catalog_key=excluded.catalog_key,
 root_product_key=excluded.root_product_key,
 alias_type=excluded.alias_type,
 is_active=true,
 note=excluded.note,
 updated_at=now();

create or replace function public.v8_mapping_normalize_key(p_key text)
returns jsonb
language plpgsql stable
set search_path to 'public'
as $function$
declare
  v_key text:=lower(btrim(coalesce(p_key,'')));
  r record;
begin
  if v_key='' then return '{}'::jsonb; end if;
  select * into r from public.v8_mapping_key_aliases where alias_key=v_key and is_active limit 1;
  if r.alias_key is not null then
    return jsonb_build_object('input_key',p_key,'group_key',r.canonical_group_key,'catalog_key',r.catalog_key,'root_product_key',r.root_product_key,'source','key_alias');
  end if;
  if exists(select 1 from public.v8_product_catalog where catalog_key=v_key and is_active) then
    return jsonb_build_object(
      'input_key',p_key,'catalog_key',v_key,
      'root_product_key',(select root_product_key from public.v8_product_catalog where catalog_key=v_key limit 1),
      'group_key',(select group_key from public.v8_resolve_business_group(v_key) limit 1),
      'source','catalog_key'
    );
  end if;
  if exists(select 1 from public.v8_business_product_groups where group_key=v_key and is_active) then
    return jsonb_build_object('input_key',p_key,'group_key',v_key,'source','group_key');
  end if;
  return jsonb_build_object('input_key',p_key,'source','unresolved');
end;
$function$;

create or replace function public.v8_mapping_folder_ids(p_value jsonb)
returns text[]
language sql immutable
set search_path to 'public'
as $function$
  select coalesce(array_agg(distinct x.id) filter(where x.id is not null and x.id<>''),array[]::text[])
  from (
    select case
      when jsonb_typeof(e.value)='string' then trim(both '"' from e.value::text)
      when jsonb_typeof(e.value)='object' then coalesce(e.value->>'id',e.value->>'folder_id',e.value->>'drive_folder_id')
      else null end as id
    from jsonb_array_elements(case when jsonb_typeof(coalesce(p_value,'[]'::jsonb))='array' then coalesce(p_value,'[]'::jsonb) else '[]'::jsonb end) e(value)
  ) x;
$function$;
