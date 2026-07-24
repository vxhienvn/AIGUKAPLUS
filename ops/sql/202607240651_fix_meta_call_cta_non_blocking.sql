-- Applied manually to production Supabase on 2026-07-24.
-- Stored here for audit; do not auto-replay during Railway startup.
-- Meta's click-to-call companion text is Page automation, not a Sale/Admin reply.
create or replace function public.v8_is_known_page_automation_text(p_message_text text)
returns boolean
language sql
stable
set search_path to 'public'
as $function$
  with n as (
    select public.v8_normalize_detector_text(coalesce(p_message_text,'')) as txt
  )
  select
    txt like 'xin chao % ban dang tim lavabo thiet ke sang trong bon cau thong minh%hotline 0973693677%'
    or txt like 'chao % ban dang tim thiet bi nha tam chung toi co nhieu mau lavabo dep%'
    or txt like 'chao % chung toi co the giup gi cho ban%'
    or txt = 'showroom anh duong toa lac tai so 254 pho keo gia lam ha noi'
    or txt like 'da showroom % 254 pho keo%gia lam ha noi%'
    or txt like 'anh chi vui long de lai so dien thoai hoac lien he hotline 0973693677%'
    or txt like 'da em chao anh chi a khong biet minh dang tham khao mau nao ben em%bao gia chi tiet%'
    or (txt like 'em chao % hien % quan tam san pham nao ben em%' and txt like '%097 369 36 77%' and txt like '%guka japan com%')
    or txt = 'loi api toomanyrequests'
    or txt like '%muon gui tin nhan cho ban do co the la tin nhan quang cao%'
    or txt like '%khach hang tiem nang van o giai doan du dieu kien hay gui tin nhan de duy tri ket noi%'
    or txt like '%da phat hien va thu thap thong tin ve khach hang tiem nang%'
    or txt = 'hay goi ngay de duoc phuc vu nhanh hon'
    or txt like 'goi cho tong kho thiet bi bep va nha tam mien bac%'
    or txt like 'goi cho tong kho%'
  from n;
$function$;
