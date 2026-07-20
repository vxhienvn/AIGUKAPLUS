-- Mapping verified from recent Meta referral conversations on 2026-07-20.
-- Generic/multi-product ads intentionally stay at scope level so the customer's
-- wording wins and the bot cannot force an unrelated product or slide.

with verified_mappings(
  ad_id,
  ad_name,
  product_group,
  product_item_key,
  product_name,
  mapping_target_type,
  notes
) as (
  values
    ('120252457407580195', '02_Group_1', 'combo_phong_tam', 'combo_phong_tam_ve_sinh', 'Combo phòng tắm', 'group', 'Đối chiếu hội thoại Meta: khách hỏi combo phòng tắm.'),
    ('120244680303950424', 'Combo tháng 6-7_Group_1', 'combo_phong_tam', 'combo_phong_tam_ve_sinh', 'Combo phòng tắm', 'group', 'Tên QC và hội thoại đều xác nhận combo phòng tắm.'),
    ('120245072479910424', 'Gạch men - Bản sao', 'gach_da_op_lat', 'gach_ngoi', 'Gạch đá ốp lát', 'group', 'Đối chiếu hội thoại Meta: khách hỏi kích thước và mẫu gạch.'),
    ('120252450697520195', 'New Video 2 - Bản sao', 'bon_cau', 'bon_cau', 'Bồn cầu', 'group', 'Đối chiếu hội thoại Meta: khách hỏi bồn cầu liền khối, bồn cầu trứng.'),
    ('120252492283910195', 'Quảng cáo Lượt tương tác mới', 'quat_tran', 'quat_tran_den_chum_decor', 'Quạt trần', 'group', 'Đối chiếu hội thoại Meta: khách hỏi quạt 10 cánh và xin mẫu.'),
    ('120244755296280424', 'Quạt Tổng Hợp 01', 'quat_tran', 'quat_tran_den_chum_decor', 'Quạt trần', 'group', 'Tên QC và hội thoại đều xác nhận quạt trần.'),
    ('120252252868730195', 'Quạt_Group_1_Video', 'quat_tran', 'quat_tran_den_chum_decor', 'Quạt trần', 'group', 'Tên QC và hội thoại đều xác nhận quạt trần.'),

    ('120239561508490648', 'Cửa hàng', 'general', '', 'Quảng cáo tổng hợp', 'scope', 'QC cửa hàng; không ép sản phẩm.'),
    ('120245787796970301', 'GUKA- thẻ', 'general', '', 'Quảng cáo tổng hợp', 'scope', 'Không đủ bằng chứng cho một sản phẩm; giữ phạm vi tổng hợp.'),
    ('120245129460030424', 'IMG- Tri ân', 'general', '', 'Chương trình tri ân tổng hợp', 'scope', 'Chương trình có nhiều nhóm sản phẩm; lời khách quyết định.'),
    ('120245117087980424', 'IMG- Tri ân_Group_1_Video', 'general', '', 'Chương trình tri ân tổng hợp', 'scope', 'Chương trình có nhiều nhóm sản phẩm; lời khách quyết định.'),
    ('120245129460080424', 'tri ân', 'general', '', 'Chương trình tri ân tổng hợp', 'scope', 'Chương trình có nhiều nhóm sản phẩm; lời khách quyết định.'),
    ('120252361768650195', 'New Video 2', 'general', '', 'Quảng cáo tổng hợp', 'scope', 'Hội thoại phát sinh nhiều nhóm sản phẩm; không ép sản phẩm.'),
    ('120252450697530195', 'News Video - Bản sao_Group_1', 'general', '', 'Quảng cáo tổng hợp', 'scope', 'Hội thoại phát sinh nhiều nhóm sản phẩm; không ép sản phẩm.'),
    ('120252361768630195', 'News Video_Group_1', 'general', '', 'Quảng cáo tổng hợp', 'scope', 'Hội thoại phát sinh nhiều nhóm sản phẩm; không ép sản phẩm.'),
    ('120245589230950648', 'Quảng cáo Lượt tương tác mới', 'general', '', 'Quảng cáo tổng hợp', 'scope', 'Không đủ bằng chứng cho một sản phẩm; giữ phạm vi tổng hợp.'),
    ('120252481719880195', 'Quảng cáo Lượt tương tác mới', 'general', '', 'Quảng cáo tổng hợp', 'scope', 'Khách mới chỉ hỏi địa chỉ; giữ phạm vi tổng hợp.'),
    ('120245127925570424', 'Tổng hợp- Khuyến mại', 'general', '', 'Khuyến mại tổng hợp', 'scope', 'QC tổng hợp nhiều sản phẩm; lời khách quyết định.'),
    ('120245233470750424', 'Tổng hợp- Khuyến mại', 'general', '', 'Khuyến mại tổng hợp', 'scope', 'Hội thoại phát sinh nhiều nhóm sản phẩm; không ép sản phẩm.'),
    ('120245161416050424', 'Tổng hợp- Khuyến mại - Bản sao', 'general', '', 'Khuyến mại tổng hợp', 'scope', 'Hội thoại phát sinh nhiều nhóm sản phẩm; không ép sản phẩm.'),
    ('120241396452570648', 'Xả Kho', 'general', '', 'Xả kho tổng hợp', 'scope', 'Tên QC không xác định duy nhất một sản phẩm; giữ phạm vi tổng hợp.')
)
insert into public.ad_mappings (
  ad_id,
  ad_name,
  product_type,
  product_name,
  product_group,
  product_item_key,
  recognition_name,
  mapping_target_type,
  mapping_mode,
  slide_key,
  selected_folders,
  drive_folders,
  image_urls,
  notes,
  enabled,
  is_active,
  effective_status,
  created_at,
  updated_at
)
select
  ad_id,
  ad_name,
  product_group,
  product_name,
  product_group,
  product_item_key,
  ad_name,
  mapping_target_type,
  'verified_conversation_20260720',
  nullif(product_item_key, ''),
  '[]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  notes,
  true,
  true,
  'ACTIVE',
  now(),
  now()
from verified_mappings
on conflict (ad_id) do nothing;

do $$
declare
  expected_count constant integer := 21;
  actual_count integer;
begin
  select count(*)
  into actual_count
  from public.ad_mappings
  where ad_id = any(array[
    '120252457407580195','120244680303950424','120245072479910424',
    '120252450697520195','120252492283910195','120244755296280424',
    '120252252868730195','120239561508490648','120245787796970301',
    '120245129460030424','120245117087980424','120245129460080424',
    '120252361768650195','120252450697530195','120252361768630195',
    '120245589230950648','120252481719880195','120245127925570424',
    '120245233470750424','120245161416050424','120241396452570648'
  ]::text[]);

  if actual_count <> expected_count then
    raise exception 'Current ad Mapping verification failed: expected %, got %', expected_count, actual_count;
  end if;
end;
$$;
