create table if not exists public.v10_pancake_media_cache (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  asset_key text not null,
  source_url text not null,
  content_id text,
  status text not null default 'pending' check (status in ('pending','ready','failed')),
  mime_type text,
  file_name text,
  upload_attempts integer not null default 0,
  last_error text,
  uploaded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(page_id, asset_key)
);

create index if not exists v10_pancake_media_cache_status_idx
  on public.v10_pancake_media_cache(page_id,status,updated_at desc);

alter table public.v10_pancake_media_cache enable row level security;
revoke all on table public.v10_pancake_media_cache from anon, authenticated;
grant all on table public.v10_pancake_media_cache to service_role;

comment on table public.v10_pancake_media_cache is
  'Caches Pancake upload content IDs for catalog images so native Pancake media transport can show all slide images in Pancake while still delivering them to Messenger.';
