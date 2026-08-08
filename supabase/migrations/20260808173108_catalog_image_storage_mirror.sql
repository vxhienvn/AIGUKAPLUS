alter table public.v8_drive_assets add column if not exists storage_path text;
alter table public.v8_drive_assets add column if not exists storage_url text;
alter table public.v8_drive_assets add column if not exists storage_status text not null default 'pending';
alter table public.v8_drive_assets add column if not exists storage_synced_at timestamptz;
alter table public.v8_drive_assets add column if not exists storage_error text;

create index if not exists v8_drive_assets_storage_status_idx
  on public.v8_drive_assets(storage_status)
  where is_active and is_image;

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values (
  'aiguka-catalog-images',
  'aiguka-catalog-images',
  true,
  26214400,
  array['image/jpeg','image/png','image/webp','image/gif']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
