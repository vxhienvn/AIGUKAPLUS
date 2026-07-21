-- Page-specific showroom/event knowledge for Tổng Kho and a runtime fix so a
-- welcome message sent before the customer's inbound turn does not suppress
-- AIGUKA's reply to that turn.

do $$
declare
  v_context_id uuid;
  v_version integer;
  v_content text := $ctx$
# PAGE TỔNG KHO — THÔNG TIN SHOWROOM VÀ CHƯƠNG TRÌNH HIỆN HÀNH

Áp dụng riêng cho Page: Tổng Kho Thiết Bị Bếp & Nhà Tắm Miền Bắc (page_id 104810069068200).

## Thông tin phải dùng chính xác
- Tên đơn vị: Showroom Ánh Dương.
- Địa chỉ duy nhất được xác nhận để mời khách đến xem trực tiếp: 254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội.
- Hotline: 0973 693 677.
- Không được nói showroom chỉ bán online, không có địa chỉ cố định, có nhiều chi nhánh, có chi nhánh tại TP.HCM hoặc tự bịa địa chỉ khác.
- Khi khách hỏi địa chỉ/showroom/cửa hàng ở đâu: trả lời thẳng địa chỉ trên trước, sau đó mới hỏi khu vực hoặc thời gian khách dự kiến đến để hỗ trợ chỉ đường và chuẩn bị mẫu.

## Chương trình tại showroom
Câu giới thiệu chuẩn, ngắn gọn:
“Showroom đang hỗ trợ chi phí đi lại hoặc khấu trừ vào hóa đơn. Đặc biệt, mua combo từ 30 triệu được chọn máy hút mùi Fudeer hoặc quạt trần vàng gương cao cấp ạ.”

Quy tắc sử dụng:
- Chỉ chủ động giới thiệu khi khách hỏi địa chỉ/showroom, ưu đãi/khuyến mại, chi phí đi lại, đang cân nhắc đến xem trực tiếp, hoàn thiện nhà hoặc hỏi combo lớn.
- Không chèn chương trình vào mọi câu trả lời.
- Quà tặng là chọn 1 trong 2: máy hút mùi Fudeer hoặc quạt trần vàng gương cao cấp; không nói khách nhận cả hai.
- Không tự đưa ra số tiền hỗ trợ đi lại, bán kính áp dụng, cách trả tiền mặt, điều kiện cộng dồn hoặc thời hạn chương trình khi chưa có dữ liệu xác nhận.
- Khi khách hỏi chi tiết phần chưa xác nhận, xin khu vực và thông tin liên hệ để Sale xác nhận chính sách cụ thể.
- Số lượng quà có hạn có thể được nhắc khi phù hợp, nhưng không tạo áp lực quá mức.

## Cách nói ưu tiên
- Ngắn, tự nhiên, đúng trọng tâm.
- Ví dụ khi khách hỏi địa chỉ:
“Dạ showroom bên em tại 254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội ạ. Hiện showroom đang hỗ trợ chi phí đi lại hoặc khấu trừ vào hóa đơn; combo từ 30 triệu được chọn máy hút mùi Fudeer hoặc quạt trần vàng gương cao cấp. Mình dự kiến qua ngày nào để em hỗ trợ trước ạ?”
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
      'Tổng Kho — Showroom & Event tháng 7/2026',
      '104810069068200','admin_event',v_content,'PRODUCTION',1,true,1,
      jsonb_build_object(
        'event_type','showroom_visit_support',
        'effective_from','2026-07-21',
        'address_verified',true,
        'gift_threshold_vnd',30000000,
        'gift_choice_count',1
      ),
      'migration','migration',now(),now()
    ) returning id,current_version into v_context_id,v_version;
  else
    v_version := coalesce(v_version,0)+1;
    update public.v8_ai_contexts
    set context_name='Tổng Kho — Showroom & Event tháng 7/2026',
        page_id='104810069068200',
        source_type='admin_event',
        content=v_content,
        usage_mode='PRODUCTION',
        priority=1,
        is_active=true,
        current_version=v_version,
        metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
          'event_type','showroom_visit_support',
          'effective_from','2026-07-21',
          'address_verified',true,
          'gift_threshold_vnd',30000000,
          'gift_choice_count',1,
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
    'Tổng Kho — Showroom & Event tháng 7/2026',
    '104810069068200','admin_event',v_content,'PRODUCTION',1,true,
    'Bổ sung chương trình hỗ trợ đi lại/khấu trừ hóa đơn và quà combo từ 30 triệu; khóa thông tin địa chỉ chính xác.',
    jsonb_build_object('deployed_live',true),
    'migration',now()
  )
  on conflict(context_id,version_no) do update set
    content=excluded.content,
    usage_mode=excluded.usage_mode,
    priority=excluded.priority,
    is_active=excluded.is_active,
    change_note=excluded.change_note,
    metadata=excluded.metadata;
end $$;

create or replace function public.v8_clear_pre_inbound_page_pause()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.direction='inbound'
     and new.actor_type='customer'
     and new.customer_id is not null then
    update public.v8_conversation_states
    set manual_pause_until=null,
        updated_at=now()
    where customer_id=new.customer_id
      and manual_pause_until>now()
      and coalesce(last_human_message_at,'-infinity'::timestamptz)<new.sent_at;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_v8_clear_pre_inbound_page_pause on public.v8_messages_raw;
create trigger trg_v8_clear_pre_inbound_page_pause
after insert on public.v8_messages_raw
for each row
execute function public.v8_clear_pre_inbound_page_pause();
