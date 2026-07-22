# AIGUKA unified pipeline architecture — 2026-07-22

## Mục tiêu

Hợp nhất các đường xử lý trả lời đang trùng lặp hoặc đã cũ thành một pipeline duy nhất. AI vẫn là bên quyết định nghiệp vụ cuối cùng; các rule, context, mapping, cảnh báo và recovery chỉ được hỗ trợ, không tự tạo một đường trả lời khác.

## Kiến trúc chuẩn `unified_v1`

```text
Meta inbound
  -> messages_raw / conversation state
  -> AI Brain request
  -> AI decision
  -> v8_ai_stage_decision
       -> v8_stage_slide_log   (tối đa một carousel, một catalog)
       -> v8_stage_reply_plan  (một text plan cho một AI decision)
  -> outbound queue
  -> v8_authorize_outbound_send
  -> Meta transport
  -> delivery confirmation / history reconciliation
```

AI chính, follow-up và recovery đều dùng cùng entrypoint `v8_ai_stage_decision`. Không còn đường staging riêng cho follow-up hoặc recovery.

## Thành phần đã bỏ hoặc hợp nhất

1. Gỡ cron `aiguka_v8_reply_planner` và biến `v8_build_reply_plans` thành hàm no-op có đánh dấu decommissioned.
2. Gỡ trigger tự stage reply plan `trg_v8_stage_outbound_from_reply_plan`.
3. Gỡ trigger tự stage từng slide `trg_v8_stage_outbound_from_slide`.
4. Gỡ trigger cancel trùng `trg_v8_cancel_outbound_on_conversation_activity`; việc đối chiếu hội thoại chỉ còn ở reconciliation/final gate.
5. Gỡ `trg_v8_clear_pre_inbound_page_pause`; inbound mới không được tự xóa pause của Sale/Admin đã xác nhận.
6. Gỡ immediate unknown guard `trg_v8_zzzz_ai_unresolved_page_guard`; Page-history chưa rõ nguồn phải chờ cửa sổ actor 18 giây.
7. Recovery và SLA watchdog không còn sửa thẳng reply plan/outbound hoặc xóa manual pause. Chúng chỉ gọi lại canonical AI stage.
8. Loại bỏ nhánh carousel `multi_product`/`multi_catalog_balanced`; một carousel chỉ có một catalog thật.

## Dấu vết và chống trùng

Đã thêm `ai_decision_id` và `pipeline_version` vào:

- `v8_reply_plans`
- `v8_slide_logs`
- `v8_outbound_queue`

Ràng buộc mới:

- một reply plan chính trên mỗi `ai_decision_id`;
- một asset chỉ xuất hiện một lần trong slide batch của cùng AI decision;
- outbound có index truy vết theo AI decision.

Các dòng mới dùng `pipeline_version = unified_v1`. Dữ liệu cũ được giữ để audit với nhãn `pre_unified_ai`, `legacy` hoặc `legacy_duplicate`, nhưng không còn quyền gửi.

## Slide/carousel

- AI catalog exact có asset verified là nguồn quyết định chính.
- Asset ID cũ hoặc sai không được đổi phạm vi sản phẩm AI đã chọn.
- Catalog có từ 10 ảnh verified: đúng một carousel 10 thẻ.
- Catalog dưới 10 ảnh: đúng một carousel chứa toàn bộ ảnh verified.
- Không tạo outbound `image` rời.
- Parent catalog chỉ được resolve sang đúng một child catalog khi parent không có asset trực tiếp.
- Mixed catalog bị chặn trước khi vào outbound và tại final guard.

## Actor settlement

- `automation_grace_seconds = 18`.
- `automation_pause_seconds = 0`.
- Một Page-history chưa rõ nguồn: giữ `page_or_system`, không pause, không hủy AI ngay.
- Hai tin Page-history khác nhau, có nội dung, không phải mẫu automation: tạm xác nhận `human_admin`, pause 10 phút.
- Bằng chứng automation xuất hiện muộn trong 20 giây: hoàn tác `delayed_human_cluster`, đổi toàn cụm về `meta_page_automation`, xóa pause và restage AI qua pipeline chuẩn.
- Meta/Page automation, Botcake/AIcake automation không bao giờ tạo manual pause.

## Regression/test isolation

Test giả lập trước đây tạo customer giả rồi vô tình đưa vào Meta sync queue, làm worker degraded. Đã sửa:

- customer/sender `regression-*`, `settle-*`, `e2e-*`, `sla-*`, `SELFTEST_*` không được enqueue Meta sync;
- outbound của regression có `due_at` xa để worker thật không claim trong lúc test;
- regression xóa đầy đủ outbound, slide, reply plan, AI decision, request, message, state, memory và customer;
- dọn toàn bộ orphan decision/sync queue do test cũ để lại.

## SLA watchdog

`v8_reconcile_ai_delivery_sla` chỉ còn:

1. enqueue lượt khách Meta thật bị thiếu AI request;
2. gọi `v8_ai_stage_decision` cho completed decision chưa stage;
3. gọi lại canonical stage cho plan thiếu outbound;
4. giải phóng transport lock quá hạn.

Watchdog không còn tự đổi câu trả lời, không tự sửa catalog, không tự bật lại một legacy plan và không xóa pause Sale/Admin.

## Health check

Nguồn chuẩn: `v8_unified_pipeline_health()`.

Điều kiện khỏe:

- `legacy_reply_cron_active = 0`
- `removed_triggers_still_present = 0`
- `missing_required_triggers = 0`
- `active_legacy_sendable_plans = 0`
- `duplicate_active_plans_per_decision = 0`
- `mixed_unified_carousels = 0`
- `loose_unified_images = 0`
- `page_actor_config_violations = 0`
- `pause_on_unknown_outbound_source = false`
- required workers đều healthy

## Kết quả xác minh production

- `v8_regression_test_unified_pipeline()` -> `ok = true`.
- Actor settlement -> `ok = true`.
- Automation companion non-blocking -> `ok = true`.
- Exact catalog/10-card carousel -> `ok = true`.
- Toàn bộ catalog slide -> `22/22` đạt.
- Không mixed carousel, không image rời, không plan trùng theo AI decision.
- AI/outbound/Meta sync/Drive sync worker đều healthy sau khi dọn test artifacts.

Đã có traffic thật sau khi kích hoạt:

- Khách `Vũ Thị Hương`, Page Tổng Kho.
- AI decision completed.
- Reply plan `pipeline_version = unified_v1`.
- Outbound `pipeline_version = unified_v1`.
- Gửi Meta thành công.

## Các migration đã áp dụng trực tiếp trên production

- `unify_ai_pipeline_trace_columns`
- `unify_ai_pipeline_trace_backfill`
- `remove_duplicate_ai_pipeline_triggers`
- `unified_ai_pipeline_canonical_stage_v1`
- `prefer_exact_ai_catalog_over_wrong_selected_assets`
- `restore_two_message_human_actor_settlement`
- `add_unified_pipeline_health_and_regression`
- `isolate_regression_outbound_from_live_workers`
- `scope_unified_health_errors_to_activation`
- `route_sla_recovery_through_unified_pipeline`
- `isolate_regression_customers_from_meta_sync`

## Phạm vi triển khai

Đây là thay đổi database/pipeline production. Không nâng version Edge Function `aiguka-v8-ai-brain`; Edge vẫn ở version 4. Không thay đổi mã Railway worker trong lần hợp nhất này. Worker hiện dùng các RPC canonical mới từ database.

## Tiêu chuẩn ổn định

Không tuyên bố ổn định chỉ dựa trên regression. Cần duy trì ít nhất 72 giờ traffic thật với:

- không khách bị bỏ do lỗi nội bộ;
- không legacy path tái xuất hiện;
- không mixed carousel hoặc ảnh rời;
- không unknown/automation tạo pause sai;
- không follow-up ghi đè AI chính;
- không pending/processing kẹt;
- `v8_unified_pipeline_health().ok = true` liên tục.
