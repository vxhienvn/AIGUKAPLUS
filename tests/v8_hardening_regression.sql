-- Read-only regression probes for V8 hardening.
-- These statements do not send messages and do not insert production queue rows.

with cases(name,input_text,expected_status,expected_intent,expected_auto) as (
  values
    ('comment_price','Giá bao nhiêu vậy','qualified','ask_price',true),
    ('comment_ib','Ib nhé','qualified','ask_consult',true),
    ('comment_phone','Liên hệ 0988123456','contact_provided','provide_contact',false),
    ('comment_tag','@nguyenvana','ignored',null,false),
    ('comment_complaint','Sản phẩm bị lỗi, không hài lòng','manual_review','complaint',false)
), results as (
  select c.*,
    public.v8_classify_comment_lead(c.input_text,'synthetic-user','synthetic-page','{}'::jsonb) result
  from cases c
)
select
  name,
  result,
  (result->>'lead_status'=expected_status)
    and (expected_intent is null or result->>'intent_type'=expected_intent)
    and coalesce((result->>'auto_private_reply')::boolean,false)=expected_auto as passed
from results
order by name;

with cases(name,input_text,attachments,expected_wait) as (
  values
    ('sale_only_phone','Cho xin số Zalo để tư vấn báo giá nhé','[]'::jsonb,1),
    ('sale_real_value','Mẫu này inox 304, kích thước 82 cm, bảo hành 5 năm','[]'::jsonb,8),
    ('sale_attachment','Em gửi mẫu nhé','[{"type":"image"}]'::jsonb,8)
)
select
  name,
  public.v8_sale_reply_quality(input_text,attachments) result,
  public.v8_sale_reply_wait_hours(input_text,attachments)=expected_wait as passed
from cases
order by name;

select
  public.v8_validate_reply_price_safety(
    'Dạ giá mẫu này 900 triệu ạ','capture','ask_price','bon_cau','{}'::jsonb
  )->>'reason'='EXTREME_PRICE_BLOCKED' as extreme_price_blocked,
  public.v8_validate_reply_price_safety(
    'Dạ mẫu này có nhiều mức giá theo cấu hình ạ','capture','ask_price','bon_cau','{}'::jsonb
  )->>'allowed'='true' as non_numeric_price_allowed;

-- Verify the live database has no synthetic comment-test residue.
select count(*)=0 as no_synthetic_comment_rows
from public.v8_comment_events
where page_id='TEST_COMMENT_PAGE';
