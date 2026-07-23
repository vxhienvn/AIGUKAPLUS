begin;

create table if not exists public.v8_marketing_message_subscriptions (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  sender_id text not null,
  customer_id uuid references public.v8_customers(id) on delete cascade,
  topic_key text not null default 'showroom_promotions',
  notification_messages_token text,
  status text not null default 'active' check (status in ('active','stopped','expired','invalid')),
  notification_status text,
  title text,
  payload text,
  timezone text,
  expires_at timestamptz,
  opted_in_at timestamptz,
  opted_out_at timestamptz,
  last_event_at timestamptz not null default now(),
  raw_optin jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(page_id,sender_id,topic_key)
);

create index if not exists idx_v8_marketing_subscriptions_customer
  on public.v8_marketing_message_subscriptions(customer_id,status,expires_at);

alter table public.v8_marketing_message_subscriptions enable row level security;
revoke all on public.v8_marketing_message_subscriptions from anon,authenticated;

create table if not exists public.v8_promotion_delivery_log (
  id uuid primary key default gen_random_uuid(),
  campaign_key text not null,
  subscription_id uuid references public.v8_marketing_message_subscriptions(id) on delete set null,
  customer_id uuid not null references public.v8_customers(id) on delete cascade,
  page_id text not null,
  sender_id text not null,
  source_message_row_id uuid references public.v8_messages_raw(id) on delete set null,
  reply_plan_id uuid references public.v8_reply_plans(id) on delete set null,
  outbound_id uuid references public.v8_outbound_queue(id) on delete set null,
  status text not null default 'preparing',
  requested_by text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(customer_id,campaign_key)
);

create index if not exists idx_v8_promotion_delivery_outbound
  on public.v8_promotion_delivery_log(outbound_id) where outbound_id is not null;

alter table public.v8_promotion_delivery_log enable row level security;
revoke all on public.v8_promotion_delivery_log from anon,authenticated;

insert into public.v8_config_hub(scope,key,value,description,is_active,updated_at)
values(
  'promotion',
  'showroom_event_202607_full_carousel',
  jsonb_build_object(
    'enabled',true,
    'campaign_key','showroom_event_202607_v1',
    'topic_key','showroom_promotions',
    'effective_from','2026-07-01',
    'effective_to','2026-08-31',
    'page_ids',jsonb_build_array('104810069068200','985632314640803'),
    'optin_title','NHẬN TOÀN BỘ ƯU ĐÃI THÁNG 7–8/2026',
    'zalo_number','0989882690',
    'zalo_url','https://zalo.me/0989882690',
    'elements',jsonb_build_array(
      jsonb_build_object(
        'title','ĐẠI TIỆC TRI ÂN SHOWROOM ÁNH DƯƠNG',
        'subtitle','Ưu đãi hoàn thiện nhà tắm, nhà bếp, quạt trần và nội thất tháng 7–8/2026.',
        'buttons',jsonb_build_array(jsonb_build_object('type','web_url','url','https://zalo.me/0989882690','title','Zalo 0989882690','webview_height_ratio','full'))
      ),
      jsonb_build_object(
        'title','MIỄN PHÍ VẬN CHUYỂN 7 TỈNH/THÀNH',
        'subtitle','Hà Nội, Thái Nguyên, Hải Phòng, Hưng Yên, Hà Nam, Hải Dương và Hòa Bình.',
        'buttons',jsonb_build_array(jsonb_build_object('type','web_url','url','https://zalo.me/0989882690','title','Zalo 0989882690','webview_height_ratio','full'))
      ),
      jsonb_build_object(
        'title','MIỄN PHÍ VẬN CHUYỂN TRONG 80 KM',
        'subtitle','Áp dụng cho địa chỉ trong bán kính 80 km tính từ showroom Gia Lâm.',
        'buttons',jsonb_build_array(jsonb_build_object('type','web_url','url','https://zalo.me/0989882690','title','Zalo 0989882690','webview_height_ratio','full'))
      ),
      jsonb_build_object(
        'title','HỖ TRỢ ĐI LẠI TỚI 300.000Đ',
        'subtitle','Khi qua xem và đặt hàng/đặt cọc; hỗ trợ tiền mặt hoặc trừ vào đơn theo thực tế.',
        'buttons',jsonb_build_array(jsonb_build_object('type','web_url','url','https://zalo.me/0989882690','title','Zalo 0989882690','webview_height_ratio','full'))
      ),
      jsonb_build_object(
        'title','ĐƠN TỪ 30 TRIỆU CÓ QUÀ TẶNG',
        'subtitle','Quà tùy đơn: máy hút mùi, bếp từ hoặc quạt trần vàng gương cao cấp 8–10 cánh.',
        'buttons',jsonb_build_array(jsonb_build_object('type','web_url','url','https://zalo.me/0989882690','title','Zalo 0989882690','webview_height_ratio','full'))
      ),
      jsonb_build_object(
        'title','SHOWROOM & TƯ VẤN TRỰC TIẾP',
        'subtitle','254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội • Hotline 0973 693 677.',
        'buttons',jsonb_build_array(jsonb_build_object('type','web_url','url','https://zalo.me/0989882690','title','Zalo 0989882690','webview_height_ratio','full'))
      )
    )
  ),
  'Carousel đầy đủ chương trình showroom; gửi sau khi khách đồng ý nhận ưu đãi hoặc khi còn trong cửa sổ hợp lệ.',
  true,
  now()
)
on conflict(scope,key) do update set
  value=excluded.value,
  description=excluded.description,
  is_active=true,
  updated_at=now();

commit;
