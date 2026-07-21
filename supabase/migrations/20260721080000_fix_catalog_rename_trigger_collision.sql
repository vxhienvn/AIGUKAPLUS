do $$
begin
  if to_regprocedure('public.v8_admin_rename_catalog_key_legacy(text,text)') is null then
    alter function public.v8_admin_rename_catalog_key(text,text)
      rename to v8_admin_rename_catalog_key_legacy;
  end if;
end $$;

create or replace function public.v8_trigger_sync_business_groups()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if current_setting('aiguka.catalog_rename_in_progress', true) = 'on' then
    return null;
  end if;
  perform public.v8_sync_business_group_mappings();
  return null;
end;
$$;

create or replace function public.v8_admin_rename_catalog_key(
  p_old_catalog_key text,
  p_new_catalog_key text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_result jsonb;
begin
  perform set_config('aiguka.catalog_rename_in_progress', 'on', true);
  v_result := public.v8_admin_rename_catalog_key_legacy(
    p_old_catalog_key,
    p_new_catalog_key
  );
  perform set_config('aiguka.catalog_rename_in_progress', 'off', true);
  perform public.v8_sync_business_group_mappings();
  return v_result;
exception when others then
  perform set_config('aiguka.catalog_rename_in_progress', 'off', true);
  raise;
end;
$$;

grant execute on function public.v8_admin_rename_catalog_key(text,text) to service_role;
