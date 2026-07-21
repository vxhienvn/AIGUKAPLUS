# AIGUKA AI pipeline and slide stabilization — 2026-07-22

## Incident used for the audit

Page GUKA, customer **Thuong Le** (`customer_id cbcefdfb-125e-4fb9-bb8e-5fb37f1a76ad`).

The customer asked for a wall-mounted 80 cm vanity set, both modern and classic styles, then asked for an electronic mirror and directly self-referred as `anh`.

Observed failures:

- AI catalog was `guong_tu`, but selected asset IDs came from `lavabo`.
- Legacy slide routing inserted eight wrong `lavabo` rows first and cancelled them after insert.
- Cancelled rows still occupied the unique `(message_id, slide_url)` keys.
- AI staging used `ON CONFLICT DO NOTHING`, so only two non-conflicting images were staged and sent.
- Follow-up was due immediately and could race the main AI decision/revision.
- AI memory claimed ten correct vanity images had been sent although actual delivery contained only two standalone lavabo images.
- Name inference marked `Thuong Le` female, while the customer explicitly wrote `A hoi tu treo`.
- Sales guidance did not strongly prioritize obtaining SĐT/Zalo.

## End-to-end authority map

1. Meta inbound is written to `v8_messages_raw`.
2. `v8_enqueue_ai_brain_from_live_inbound` creates the main AI request.
3. Railway `ai-dispatch-worker.js` performs profile preflight and calls `aiguka-v8-ai-brain`.
4. The AI Brain reads the full conversation and advisory tools, then writes `v8_ai_decisions`.
5. Database validators add evidence/advisories. They may not rewrite the AI reply.
6. `v8_ai_stage_decision` turns the AI action into a reply plan and exact-catalog slide batch.
7. Reply/slide triggers create `v8_outbound_queue` rows.
8. The outbound worker sends through Meta.
9. Follow-up is a separate AI path and must wait until the main AI request is final.

AI remains the final business decision-maker. Deterministic fulfillment only guarantees recipient/runtime safety, exact selected catalog, truthful asset identity, and the requested slide batch size.

## Live database changes

Applied to Supabase project `ezygfpeeqbbirdeazene`:

- `ai_learning_salutation_and_vanity_knowledge`
- `exact_catalog_ai_slide_batch_target_10_core`
- `legacy_slide_target_10_and_followup_race_guard`
- `remove_conflicting_sales_context_and_whitelist_hard_ai_blocks`
- `recognize_abbreviated_customer_self_reference`
- `add_ai_slide_exact_10_regression_test`
- `fix_ai_slide_regression_uuid_aggregate`
- `store_truthful_slide_delivery_in_ai_memory`
- `align_ai_context_priority_with_runtime_order`

Key behavior now:

- Direct customer self-reference (`anh/a hỏi`, `chị/c hỏi`, etc.) is stronger evidence than names or profile guesses.
- Automatic gender inference from Vietnamese names is disabled.
- `gương điện tử`, `gương LED`, `gương cảm ứng`, `tủ chậu lavabo`, `tủ lavabo treo`, `tủ treo 80cm`, one-tier and two-tier vanity phrases resolve to `guong_tu`.
- Standalone `chậu lavabo` remains in `lavabo`.
- Unknown or low-confidence product/catalog: no nearby-category image guess; AI uses the customer’s wording and asks SĐT/Zalo to filter the exact model.
- Contact-first policy: short answer, one concrete value, request SĐT/Zalo early; deep Messenger consulting only after a firm second refusal or explicit refusal.
- Soft refusal such as “gửi ở đây” does not end contact conversion when the customer still asks price, selects models or sends images.
- Critical contexts use the actual runtime priority convention (lower number first).
- Business-language, salutation, slide count and routing checks are advisory.
- Only true hard factual/transport safety may stop staging. Unverified numeric price remains a hard no-invention rule.

## Slide policy

- AI decides whether a slide is appropriate and decides the catalog.
- Fulfillment uses **only the exact AI catalog**.
- Target batch is **10 verified images**.
- If the exact catalog/folder has fewer than 10 verified images, send all verified images in that catalog/folder.
- Never mix a nearby catalog merely to reach 10.
- Legacy slide rows are rejected before insert when AI Brain is active, so they cannot occupy unique keys.
- Existing cancelled rows can be reclaimed with `ON CONFLICT DO UPDATE`.
- Slide metadata is forced to match the real `v8_drive_assets` row.
- AI memory receives a truthful `last_slide_batch` built from actual slide logs and asset rows.

## Follow-up race prevention

- A fresh unanswered inbound is not eligible before 10 minutes.
- No follow-up request is created while the main AI request is pending, processing or error/retry.
- No follow-up request is created while the main AI decision is processing or revision-required.
- The same guards are repeated when a follow-up request is prepared.

## Regression test

RPC: `v8_regression_test_ai_slide_exact_10()`

Final result after Drive reconciliation:

```json
{
  "ok": true,
  "legacy_rows_inserted": 0,
  "slides_staged": 10,
  "wrong_catalog_slides": 0,
  "image_outbound_rows": 10,
  "stage_result": {
    "decision_authority": "ai",
    "slide_catalog": "guong_tu",
    "slide_available_images": 42,
    "slide_target_images": 10
  }
}
```

The test intentionally gives the AI decision two wrong `lavabo` asset IDs while declaring `guong_tu`. The fulfillment layer discards the wrong-category choices, stages ten exact `guong_tu` assets, creates ten image outbound rows, and allows zero legacy rows.

## Drive inventory audit

Direct Google Drive inspection found:

- `GƯƠNG TỦ`: 32 direct image files.
- `GƯƠNG`: 10 direct image files.
- Total direct images in the two selected folders: 42.

Supabase originally had 30 verified `guong_tu` assets because 12 files had been uploaded after the previous completed sync. The 12 missing files were reconciled and delivery-verified. Supabase now has **42 active and 42 verified** `guong_tu` assets.

The old `v8_request_drive_sync` RPC only marked `sync_status=requested`; it had no background consumer. Repository fix:

- Added `drive-sync-request-worker.js`.
- Started it from `start.js`.
- It claims requested mappings, calls the existing recursive `/api/slide-manager/drive/sync` route, writes success/error, and reports a worker heartbeat.
- Production heartbeat is healthy (`requested_mapping_sync_v1`).
- The `guong_tu` mapping finished successfully with no sync error.

## Pipeline trace

RPC: `v8_trace_message_pipeline(page_id, sender_id, message_id)`

It returns the raw message, processing queue, AI request, AI decision, reply plan, slide logs and outbound rows in one payload. Monitoring should use this trace instead of checking only sent messages or only AI output.
