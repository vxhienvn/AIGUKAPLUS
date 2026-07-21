-- Update the monthly showroom event for the Tổng Kho page and make it available
-- to both normal AI decisions and scheduled follow-up requests.

do $$
declare
  v_context_id uuid;
  v_version integer;
  v_content text := $ctx$
# PAGE TỔNG KHO — EVENT SHOWROOM THÁNG 7/2026 (ƯU TIÊN CAO)

Áp dụng riêng cho Page Tổng Kho Thiết Bị Bếp & Nhà Tắm Miền Bắc, page_id 104810069068200.
Đây là event quan trọng trong tháng. BOT phải ưu tiên phổ biến đúng quyền lợi khi phù hợp, đặc biệt trong các tin chăm sóc lại; không chèn máy móc hoặc lặp lại nếu khách đã được thông báo gần đây.

## Thông tin showroom bắt buộc dùng đúng
- Showroom Ánh Dương, 254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội.
- Hotline: 0973 693 677.
- Không nói showroom chỉ bán online, không có địa chỉ cố định, có nhiều chi nhánh hoặc tự bịa địa chỉ khác.

## Miễn phí vận chuyển
- Miễn phí vận chuyển tại Hà Nội, Thái Nguyên, Hải Phòng, Hưng Yên, Hà Nam, Hải Dương và Hòa Bình.
- Đồng thời áp dụng miễn phí vận chuyển cho địa chỉ nằm trong bán kính 80 km tính từ showroom.
- Khi chưa rõ địa chỉ nhận hàng, hỏi quận/huyện và tỉnh/thành trước khi xác nhận.

## Hỗ trợ chi phí đi lại đến showroom
- Mức hỗ trợ tối đa 300.000 đồng, mức thực tế căn cứ theo khoảng cách.
- Áp dụng cho khách đến showroom xem hàng, cân nhắc hoặc đặt hàng, kể cả khách chưa mua ngay trong lần đến.
- Hỗ trợ bằng tiền mặt hoặc khấu trừ vào giá trị đơn hàng khi mua.
- Không cam kết 300.000 đồng cho mọi khách; phải nói “tối đa 300.000 đồng, tùy khoảng cách”.

## Đơn hàng từ 30 triệu
- Khách mua từ 30 triệu được nhận đồng thời hỗ trợ đi lại và quà tặng; không bắt khách chọn một trong hai quyền lợi này.
- Quà tặng tùy theo đơn hàng, có thể là máy hút mùi, bếp từ hoặc quạt trần vàng gương cao cấp 8–10 cánh.
- Không nói khách chắc chắn được chọn bất kỳ món nào nếu chưa biết cơ cấu và giá trị đơn hàng; diễn đạt là “quà tặng tùy đơn hàng”.

## Cách BOT giới thiệu
- Khách hỏi địa chỉ, muốn đến xem hoặc ở xa: ưu tiên nói hỗ trợ đi lại tối đa 300.000 đồng theo khoảng cách.
- Khách hỏi giao hàng hoặc nêu địa phương: ưu tiên giới thiệu miễn phí vận chuyển theo tỉnh hoặc bán kính 80 km.
- Khách hoàn thiện nhà, hỏi combo hoặc ngân sách lớn: ưu tiên nói đơn từ 30 triệu vẫn nhận đồng thời hỗ trợ đi lại và quà tặng tùy đơn hàng.
- Chỉ nói các quyền lợi liên quan nhất; không nhất thiết dồn toàn bộ chương trình vào một tin.
- Không bịa thời hạn, số lượng quà, điều kiện cộng dồn hoặc mức hỗ trợ ngoài nội dung đã xác nhận.

## Ưu tiên trong chăm sóc lại
- Với khách đủ điều kiện chăm sóc lại trên Page Tổng Kho, ưu tiên nhắc ít nhất một quyền lợi phù hợp để tạo lý do quay lại hội thoại.
- Khách đã cung cấp địa phương: nhắc quyền lợi vận chuyển hoặc hỗ trợ đi lại tương ứng.
- Khách quan tâm combo hoặc hoàn thiện nhà: nhắc quyền lợi đơn từ 30 triệu và quà tặng tùy đơn hàng.
- Khách chưa rõ nhu cầu: giới thiệu ngắn event rồi hỏi một câu thiết thực về khu vực hoặc hạng mục đang quan tâm.
- Không nhắc lại nguyên văn nếu quyền lợi đó vừa được gửi; chuyển sang quyền lợi phù hợp khác hoặc hỏi bước tiếp theo.

## Câu giới thiệu tổng quát tham khảo
“Hiện showroom miễn phí vận chuyển tại Hà Nội, Thái Nguyên, Hải Phòng, Hưng Yên, Hà Nam, Hải Dương, Hòa Bình hoặc trong bán kính 80 km. Khách đến showroom được hỗ trợ đi lại tối đa 300.000 đồng theo khoảng cách; đơn từ 30 triệu vẫn nhận đồng thời hỗ trợ đi lại và quà tặng tùy đơn hàng ạ.”
$ctx$;
begin
  select id,current_version into v_context_id,v_version
  from public.v8_ai_contexts
  where context_key='tong_kho_showroom_event_202607'
  for update;

  if v_context_id is null then
    insert into public.v8_ai_contexts(
      context_key,context_name,page_id,source_type,content,usage_mode,priority,
      is_active,current_version,metadata,created_by,updated_by,created_at,updated_at
    ) values (
      'tong_kho_showroom_event_202607',
      'Tổng Kho — Event showroom tháng 7/2026',
      '104810069068200','admin_event',v_content,'PRODUCTION',0,true,1,
      jsonb_build_object(
        'event_type','monthly_showroom_priority_event',
        'effective_from','2026-07-21',
        'event_priority','high',
        'follow_up_priority',true,
        'free_shipping_provinces',jsonb_build_array('Hà Nội','Thái Nguyên','Hải Phòng','Hưng Yên','Hà Nam','Hải Dương','Hòa Bình'),
        'free_shipping_radius_km',80,
        'travel_support_max_vnd',300000,
        'gift_threshold_vnd',30000000,
        'gift_options',jsonb_build_array('Máy hút mùi','Bếp từ','Quạt trần vàng gương 8–10 cánh')
      ),
      'migration','migration',now(),now()
    ) returning id,current_version into v_context_id,v_version;
  else
    v_version := coalesce(v_version,0)+1;
    update public.v8_ai_contexts
    set context_name='Tổng Kho — Event showroom tháng 7/2026',
        page_id='104810069068200',
        source_type='admin_event',
        content=v_content,
        usage_mode='PRODUCTION',
        priority=0,
        is_active=true,
        current_version=v_version,
        metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
          'event_type','monthly_showroom_priority_event',
          'effective_from','2026-07-21',
          'event_priority','high',
          'follow_up_priority',true,
          'free_shipping_provinces',jsonb_build_array('Hà Nội','Thái Nguyên','Hải Phòng','Hưng Yên','Hà Nam','Hải Dương','Hòa Bình'),
          'free_shipping_radius_km',80,
          'travel_support_max_vnd',300000,
          'gift_threshold_vnd',30000000,
          'gift_options',jsonb_build_array('Máy hút mùi','Bếp từ','Quạt trần vàng gương 8–10 cánh'),
          'last_updated_at',now()
        ),
        updated_by='migration',
        updated_at=now()
    where id=v_context_id;
  end if;

  insert into public.v8_ai_context_versions(
    context_id,version_no,context_name,page_id,source_type,content,usage_mode,
    priority,is_active,change_note,metadata,created_by,created_at
  ) values (
    v_context_id,v_version,
    'Tổng Kho — Event showroom tháng 7/2026',
    '104810069068200','admin_event',v_content,'PRODUCTION',0,true,
    'Cập nhật miễn phí vận chuyển, hỗ trợ đi lại tối đa 300K, quà đơn từ 30 triệu và ưu tiên phổ biến trong chăm sóc lại.',
    jsonb_build_object('deployed_live',true,'follow_up_priority',true),
    'migration',now()
  )
  on conflict(context_id,version_no) do update set
    content=excluded.content,
    usage_mode=excluded.usage_mode,
    priority=excluded.priority,
    is_active=excluded.is_active,
    change_note=excluded.change_note,
    metadata=excluded.metadata;

  update public.v8_config_hub
  set value=coalesce(value,'{}'::jsonb)||jsonb_build_object(
        'priority_event_enabled',true,
        'priority_event_context_key','tong_kho_showroom_event_202607',
        'priority_event_page_id','104810069068200',
        'priority_event_follow_up',true,
        'priority_event_updated_at',now()
      ),
      updated_at=now()
  where key='follow_up_policy' and scope='conversation';
end $$;

create or replace function public.v8_inject_priority_event_follow_up()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event jsonb;
begin
  if new.requested_by='follow_up_scan' and new.page_id='104810069068200' then
    select jsonb_build_object(
      'context_key',context_key,
      'context_name',context_name,
      'content',content,
      'metadata',metadata,
      'instruction','Đây là event quan trọng trong tháng. Khi chăm sóc lại, ưu tiên nhắc một quyền lợi phù hợp nhất để kéo khách quay lại; không lặp nếu vừa nhắc và không bịa điều kiện.'
    ) into v_event
    from public.v8_ai_contexts
    where context_key='tong_kho_showroom_event_202607'
      and is_active=true
      and usage_mode='PRODUCTION'
    limit 1;

    if v_event is not null then
      new.dispatch_details:=coalesce(new.dispatch_details,'{}'::jsonb)
        || jsonb_build_object('priority_event',v_event);
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_v8_inject_priority_event_follow_up on public.v8_ai_brain_requests;
create trigger trg_v8_inject_priority_event_follow_up
before insert or update of dispatch_details,status on public.v8_ai_brain_requests
for each row
execute function public.v8_inject_priority_event_follow_up();
