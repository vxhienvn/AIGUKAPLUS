-- Safely rename a catalog key and migrate every operational reference in one transaction.
-- The old key remains active as an alias so legacy messages/configuration still resolve.

create or replace function public.v8_admin_rename_catalog_key(
  p_old_catalog_key text,
  p_new_catalog_key text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old_key text := lower(btrim(coalesce(p_old_catalog_key, '')));
  v_new_key text := lower(btrim(coalesce(p_new_catalog_key, '')));
  v_old public.v8_product_catalog%rowtype;
  v_group_key text;
  v_count integer;
  v_counts jsonb := '{}'::jsonb;
begin
  if v_old_key = '' or v_new_key = '' then
    raise exception 'Thiếu mã catalog cũ hoặc mã catalog mới.' using errcode = '22023';
  end if;
  if v_old_key = v_new_key then
    return jsonb_build_object('ok', true, 'unchanged', true, 'old_catalog_key', v_old_key, 'new_catalog_key', v_new_key);
  end if;
  if v_new_key !~ '^[a-z0-9][a-z0-9_]{0,79}$' then
    raise exception 'Mã catalog mới chỉ gồm chữ thường không dấu, số và dấu gạch dưới.' using errcode = '22023';
  end if;

  select * into v_old
  from public.v8_product_catalog
  where catalog_key = v_old_key
  for update;

  if v_old.catalog_key is null then
    raise exception 'Không tìm thấy catalog %.', v_old_key using errcode = 'P0002';
  end if;
  if exists(select 1 from public.v8_product_catalog where catalog_key = v_new_key) then
    raise exception 'Mã catalog % đã tồn tại.', v_new_key using errcode = '23505';
  end if;
  if exists(
    select 1 from public.v8_mapping_key_aliases
    where alias_key = v_new_key
      and coalesce(catalog_key, '') not in ('', v_old_key, v_new_key)
  ) then
    raise exception 'Mã % đang là alias của một catalog khác.', v_new_key using errcode = '23505';
  end if;

  select canonical_group_key into v_group_key
  from public.v8_mapping_key_aliases
  where alias_key = v_old_key
  limit 1;
  if v_group_key is null then
    select group_key into v_group_key
    from public.v8_business_group_mappings
    where catalog_key = v_old_key and is_active
    order by priority, created_at
    limit 1;
  end if;

  insert into public.v8_product_catalog(
    catalog_key, catalog_name, parent_key, root_product_key,
    drive_folder_id, drive_folder_url, folder_path, level_no,
    is_sendable, is_active, metadata, created_at, updated_at
  )
  values(
    v_new_key, v_old.catalog_name, v_old.parent_key,
    case when v_old.root_product_key = v_old_key then v_new_key else v_old.root_product_key end,
    v_old.drive_folder_id, v_old.drive_folder_url, v_old.folder_path, v_old.level_no,
    v_old.is_sendable, v_old.is_active,
    coalesce(v_old.metadata, '{}'::jsonb) || jsonb_build_object(
      'renamed_from', v_old_key,
      'renamed_at', now(),
      'rename_source', 'mapping_center'
    ),
    v_old.created_at, now()
  );

  update public.v8_product_catalog set parent_key = v_new_key, updated_at = now() where parent_key = v_old_key;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('catalog_children', v_count);

  update public.v8_product_catalog set root_product_key = v_new_key, updated_at = now() where root_product_key = v_old_key;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('catalog_roots', v_count);

  update public.v8_business_group_mappings
  set catalog_key = v_new_key, updated_at = now()
  where catalog_key = v_old_key;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('business_catalog_mappings', v_count);

  update public.v8_business_group_mappings
  set root_product_key = v_new_key, updated_at = now()
  where root_product_key = v_old_key;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('business_root_mappings', v_count);

  update public.v8_product_aliases
  set catalog_key = v_new_key, updated_at = now()
  where catalog_key = v_old_key;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('product_aliases', v_count);

  update public.v8_mapping_key_aliases
  set catalog_key = case when catalog_key = v_old_key then v_new_key else catalog_key end,
      root_product_key = case when root_product_key = v_old_key then v_new_key else root_product_key end,
      updated_at = now()
  where catalog_key = v_old_key or root_product_key = v_old_key;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('mapping_key_aliases', v_count);

  -- Keep both the new canonical key and the old legacy key resolvable.
  insert into public.v8_mapping_key_aliases(
    alias_key, canonical_group_key, catalog_key, root_product_key,
    alias_type, is_active, note, updated_at
  )
  values(
    v_new_key, v_group_key, v_new_key,
    case when v_old.root_product_key = v_old_key then v_new_key else v_old.root_product_key end,
    'canonical', true, 'Mã catalog sau khi đổi từ ' || v_old_key, now()
  )
  on conflict(alias_key) do update set
    canonical_group_key = coalesce(excluded.canonical_group_key, public.v8_mapping_key_aliases.canonical_group_key),
    catalog_key = excluded.catalog_key,
    root_product_key = excluded.root_product_key,
    alias_type = 'canonical',
    is_active = true,
    note = excluded.note,
    updated_at = now();

  insert into public.v8_mapping_key_aliases(
    alias_key, canonical_group_key, catalog_key, root_product_key,
    alias_type, is_active, note, updated_at
  )
  values(
    v_old_key, v_group_key, v_new_key,
    case when v_old.root_product_key = v_old_key then v_new_key else v_old.root_product_key end,
    'legacy', true, 'Mã cũ, tự chuyển sang ' || v_new_key, now()
  )
  on conflict(alias_key) do update set
    canonical_group_key = coalesce(excluded.canonical_group_key, public.v8_mapping_key_aliases.canonical_group_key),
    catalog_key = excluded.catalog_key,
    root_product_key = excluded.root_product_key,
    alias_type = 'legacy',
    is_active = true,
    note = excluded.note,
    updated_at = now();

  update public.ad_mappings
  set product_item_key = case when product_item_key = v_old_key then v_new_key else product_item_key end,
      slide_key = case when slide_key = v_old_key then v_new_key else slide_key end,
      product_type = case when product_type = v_old_key then v_new_key else product_type end,
      carousel_key = case when carousel_key = v_old_key then v_new_key else carousel_key end,
      updated_at = now()
  where product_item_key = v_old_key or slide_key = v_old_key or product_type = v_old_key or carousel_key = v_old_key;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('ad_mappings', v_count);

  update public.v8_slide_mapping set product_key = v_new_key, updated_at = now() where product_key = v_old_key;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('slide_mappings', v_count);

  update public.v8_drive_assets
  set product_key = case when product_key = v_old_key then v_new_key else product_key end,
      catalog_key = case when catalog_key = v_old_key then v_new_key else catalog_key end,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('catalog_key_renamed_from', v_old_key, 'catalog_key_renamed_at', now())
  where product_key = v_old_key or catalog_key = v_old_key;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('drive_assets', v_count);

  update public.v8_product_rules set product_key = v_new_key, updated_at = now() where product_key = v_old_key;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('product_rules', v_count);

  update public.v8_rule_test_cases set expected_product_key = v_new_key where expected_product_key = v_old_key;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('rule_test_cases', v_count);

  update public.v8_ad_context set product_key = v_new_key, updated_at = now() where product_key = v_old_key;
  update public.v8_customers
  set last_product_key = case when last_product_key = v_old_key then v_new_key else last_product_key end,
      last_catalog_key = case when last_catalog_key = v_old_key then v_new_key else last_catalog_key end
  where last_product_key = v_old_key or last_catalog_key = v_old_key;
  update public.v8_ai_mapping_suggestions
  set suggested_catalog_key = v_new_key, updated_at = now()
  where suggested_catalog_key = v_old_key;
  update public.v8_detection_feedback
  set corrected_catalog_key = v_new_key
  where corrected_catalog_key = v_old_key;
  update public.v8_processing_queue
  set product_key = case when product_key = v_old_key then v_new_key else product_key end,
      catalog_key = case when catalog_key = v_old_key then v_new_key else catalog_key end
  where product_key = v_old_key or catalog_key = v_old_key;

  delete from public.v8_product_catalog where catalog_key = v_old_key;
  if not found then
    raise exception 'Không thể xóa mã catalog cũ % sau khi đổi.', v_old_key;
  end if;

  return jsonb_build_object(
    'ok', true,
    'unchanged', false,
    'old_catalog_key', v_old_key,
    'new_catalog_key', v_new_key,
    'updated_references', v_counts
  );
end;
$function$;

revoke all on function public.v8_admin_rename_catalog_key(text, text) from public, anon, authenticated;
grant execute on function public.v8_admin_rename_catalog_key(text, text) to service_role;

comment on function public.v8_admin_rename_catalog_key(text, text) is
'Transactionally renames a catalog key, migrates operational references and keeps the old key as a legacy alias.';
