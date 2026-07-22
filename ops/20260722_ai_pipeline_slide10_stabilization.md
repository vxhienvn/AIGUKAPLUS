# AIGUKA AI pipeline, carousel and hot-lead stabilization — 2026-07-22

## Incidents used for the audit

### Thuong Le — wrong product and wrong delivery form

The customer asked for a wall-mounted 80 cm vanity set, both modern and classic styles, then asked for an electronic mirror and directly self-referred as `anh`.

Observed failures:

- AI catalog was `guong_tu`, but selected asset IDs came from `lavabo`.
- Legacy slide routing inserted wrong `lavabo` rows before AI staging.
- AI memory claimed correct vanity images had been sent although actual delivery was wrong.
- A later correction used the correct `guong_tu` assets but transported one apology plus ten loose image messages, producing eleven Messenger messages instead of one carousel.
- Name inference and fallback salutation produced incorrect or generic forms of address.

### Ng Pang — direct purchase intent treated as a greeting

The customer wrote `Tôi muốn mua hàng` after entering from a broad advertisement.

Observed failures:

- AI classified the message as `welcome` instead of `purchase_intent`.
- `should_request_contact=false` and the reply listed product categories rather than asking SĐT/Zalo.
- Companion rows from Meta/Page automation were stored as `page_or_system/meta_page_history`, incorrectly counted as human activity and created a ten-minute manual pause.
- The corrective follow-up requested contact but still used generic `anh/chị` because the follow-up path did not receive a neutral `bạn` fallback.

## End-to-end authority map

1. Meta inbound is written to `v8_messages_raw`.
2. `v8_enqueue_ai_brain_from_live_inbound` creates the main AI request.
3. Railway `ai-dispatch-worker.js` performs profile preflight and calls `aiguka-v8-ai-brain`.
4. AI reads the full conversation and advisory tools, then writes `v8_ai_decisions`.
5. Validators add evidence and advisories; they may not write a replacement business reply.
6. `v8_ai_stage_decision` creates the reply plan and exact-catalog slide logs.
7. The slide fulfillment layer packages the selected logs into one Messenger generic-template carousel.
8. The outbound worker sends through Meta.
9. Follow-up is a separate AI path and must wait until the main AI request is final.

AI remains the final business decision-maker. Deterministic fulfillment guarantees recipient/runtime safety, exact catalog, truthful asset identity and the required transport shape.

## Product and catalog behavior

- Direct self-reference (`anh/a hỏi`, `chị/c hỏi`, etc.) is stronger evidence than names or profile guesses.
- Automatic gender inference from Vietnamese names is disabled.
- Unknown gender receives `preferred_salutation=bạn`; all AI paths, including follow-up, are instructed not to use generic `anh/chị`.
- `gương điện tử`, `gương LED`, `gương cảm ứng`, `tủ chậu lavabo`, `tủ lavabo treo`, `tủ treo 80cm`, one-tier and two-tier vanity phrases resolve to `guong_tu`.
- Standalone `chậu lavabo` remains in `lavabo`.
- Unknown or low-confidence product/catalog: do not guess a nearby catalog; use the customer's wording and ask SĐT/Zalo to filter the exact model.
- Business-language, salutation and routing guidance remain advisory to AI.

## Mandatory slide transport

When AI decides to send samples:

- One sample action creates exactly **one outbound carousel/generic template**.
- A catalog with at least ten verified images produces one carousel with ten cards.
- A catalog with fewer than ten verified images produces one carousel containing every verified image.
- Loose per-image outbound messages are forbidden for AI slide delivery.
- A nearby catalog is never mixed in to fill the card count.
- Carousel payload records `slide_log_ids`, `asset_ids`, `catalog_key` and `element_count`.
- Completion or cancellation updates every slide log in the batch, not only the anchor row.
- Existing unsent loose-image rows are superseded by the single carousel.

The outbound worker already understands generic-template carousels; the defect was that the database staged one `image` outbound per asset instead of one carousel payload.

## Carousel regression tests

### Exact `guong_tu` test

RPC: `v8_regression_test_ai_slide_exact_10()`

Final result:

```json
{
  "ok": true,
  "slides_staged": 10,
  "wrong_catalog_slides": 0,
  "loose_image_outbound_rows": 0,
  "carousel_outbound_rows": 1,
  "carousel_elements": 10,
  "carousel_catalog": "guong_tu"
}
```

The test intentionally supplies wrong `lavabo` asset IDs while declaring `guong_tu`. Fulfillment discards the wrong-category choices and creates one ten-card `guong_tu` carousel.

### All-catalog test

RPC: `v8_regression_test_all_catalog_slides()`

Final result:

- Catalogs tested: 22.
- Passed: 22.
- Failed: 0.
- Wrong-catalog slide rows: 0.
- Active loose-image outbound rows: 0.
- Every catalog creates exactly one carousel.
- Catalogs under ten verified assets include every verified asset.

## Direct purchase and high-value lead behavior

Phrases such as `Tôi muốn mua hàng`, `tôi muốn đặt hàng`, `chốt cho tôi` and `mua thế nào` are strong purchase actions:

- Intent must be `purchase_intent`, not `welcome` or `greeting`.
- `should_request_contact=true` even when the exact category is not known.
- If category is unknown, AI asks one short choice — bathroom, kitchen or both — and requests SĐT/Zalo in the same reply.
- AI does not list a long catalog before asking contact.
- If catalog is already clear, AI may send one carousel and ask contact in its lead-in.
- If catalog is not clear, AI does not send a random mixed slide.

A production E2E test using the real dispatcher and AI Brain returned:

```json
{
  "intent_type": "purchase_intent",
  "confidence": 0.96,
  "should_request_contact": true,
  "needs_clarification": true,
  "should_send_slide": false
}
```

Reply:

> Dạ bên em hỗ trợ mua hàng ngay ạ. Bạn cho em xin SĐT/Zalo và cho em biết mình đang quan tâm đồ cho nhà tắm, nhà bếp hay cả hai, em lọc đúng mẫu và chuyển tư vấn nhanh cho mình nhé.

## Meta/Page automation semantics

- `meta_page_automation` is emergency marketing copy, not Sale/Admin and not an authoritative product, price or inventory source.
- Automation must not create `manual_pause_until`, cancel AI or delay AI.
- Companion text/attachment rows around an explicit automation row are reclassified as `page_automation/meta_page_automation`, even when Meta history orders the automation before the customer's quick reply.
- Only real human outbound messages create a human pause.

The Ng Pang automation cluster was repaired and the conversation now has no human pause.

## Drive inventory and worker health

- `GƯƠNG TỦ`: 32 direct image files.
- `GƯƠNG`: 10 direct image files.
- Supabase has 42 active and 42 verified `guong_tu` assets.
- Drive sync worker, AI dispatcher, Meta profile sync and outbound worker report healthy heartbeats.

## Monitoring

`v8_trace_message_pipeline(page_id, sender_id, message_id)` returns the raw message, processing queue, AI request, AI decision, reply plan, slide logs and outbound rows in one payload.

Hourly and ten-hour monitoring now explicitly flags:

- one lead-in plus many loose image messages instead of one carousel;
- direct purchase intent classified as greeting or without contact request;
- unknown gender producing `anh/chị`;
- Meta automation companion rows producing a human pause;
- wrong catalog, wrong card count or mixed-catalog carousel.
