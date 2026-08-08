create or replace function public.v8_mark_storage_pending_on_drive_change()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  if new.is_active and new.is_image and (
    old.modified_time is distinct from new.modified_time
    or old.file_url is distinct from new.file_url
    or old.mime_type is distinct from new.mime_type
    or old.drive_file_id is distinct from new.drive_file_id
  ) then
    new.storage_status := 'pending';
    new.storage_error := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_v8_drive_assets_storage_pending on public.v8_drive_assets;
create trigger trg_v8_drive_assets_storage_pending
before update of modified_time,file_url,mime_type,drive_file_id,is_active,is_image
on public.v8_drive_assets
for each row execute function public.v8_mark_storage_pending_on_drive_change();
