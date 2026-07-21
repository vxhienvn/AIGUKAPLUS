# Live verification, cross-catalog regression and customer recovery — 2026-07-22

## Production verification

- `v8_ai_brain_runtime` is `ACTIVE` on Page `985632314640803` and `104810069068200`.
- The Drive sync worker `aiguka-drive-sync-request-worker` is healthy and reports `requested_mapping_sync_v1`.
- Live triggers are installed for:
  - enforcing slide asset identity from `v8_drive_assets`;
  - recording customer self-salutation from conversation evidence;
  - refreshing AI memory from actual slide logs.
- `v8_ai_stage_decision` contains exact-catalog target-10 fulfillment.

## Standardized policy cleanup

Canonical context now active:

- `aiguka_sales_core_policy_v2` — priority 0, production.

Retired:

- `aiguka_contact_first_policy_v1` — OFF.
- `ai_slide_count_and_salutation_policy_v2` — inactive.
- legacy manual branch `manual_8ffca68fb2266c2e` — inactive.

Supplemental references remain at lower priority:

- showroom event context — priority 5;
- combined product/conversation knowledge — priority 20.

Active canonical prompt branch:

- `ai_sales_core_policy_v3` — priority 0.

It includes:

- AI remains the final decision-maker;
- exact catalog only;
- target 10 verified images, under 10 send all;
- unknown product: no nearby-category guess, ask SĐT/Zalo to filter exact model;
- high-value lead signals and a subtle contact request;
- no deep Messenger loop before a firm second refusal;
- direct self-reference beats name inference;
- no unverified inventory claims.

## High-value lead behavior

A live end-to-end AI request was run through the real Railway dispatcher and production `aiguka-v8-ai-brain`.

Test customer message:

> Anh đang hoàn thiện nhà, cần tủ chậu lavabo treo 80cm có gương điện tử. Gửi anh cả mẫu hiện đại và tân cổ điển, cho anh hỏi giá và vận chuyển về Hưng Yên.

Production AI result:

- request completed successfully;
- catalog: `guong_tu`;
- confidence: `0.93`;
- slide requested: true;
- slide assets selected: 10;
- contact requested: true;
- clarification required: false;
- salutation used: `anh`;
- no `anh/chị`;
- no unverified numeric price;
- no unverified inventory phrase such as `có sẵn`.

The reply answered the customer’s need, explained that price depends on model/configuration and asked for SĐT/Zalo to send the exact 80 cm modern/classic sets with price and delivery details.

## Inventory claim guard

`v8_guard_ai_output` now marks unverified claims such as:

- `có sẵn`;
- `còn hàng`;
- `sẵn hàng`;
- `hàng sẵn`;
- `có hàng`;
- `giao ngay`;

as a blocking `inventory_claim_rule` and changes the decision to `revision_required`. The existing `aiguka-v8-ai-reviser` then asks AI to regenerate instead of allowing a false inventory claim to reach outbound.

## Cross-catalog slide regression

RPC: `v8_regression_test_all_catalog_slides()`

Latest result:

```json
{
  "ok": true,
  "catalogs_tested": 21,
  "passed": 21,
  "failed": 0
}
```

Each test intentionally supplied asset IDs from a different catalog. For every sendable catalog with verified images, the fulfillment layer produced:

- zero legacy slide rows;
- zero wrong-catalog slides;
- exactly 10 images when at least 10 were available;
- every verified image when fewer than 10 were available;
- the same number of image outbound rows as staged slide rows.

Catalogs tested included bathroom vanities, standalone lavabo, toilets, bathtubs, kitchen sink/faucet, induction hob/range hood, bathroom combos, chandeliers, tiles, ceiling-fan variants and shower/faucet catalogs.

## Scheduled customer recovery

Customer: Thuong Le, Page GUKA.

Scheduled for **06:45 Asia/Ho_Chi_Minh on 2026-07-22**:

1. One apology text explaining that the automated system misunderstood the need and sent incorrect images.
2. Ten verified images from the exact `GƯƠNG TỦ` Drive folder, catalog `guong_tu`.
3. The apology text asks for SĐT/Zalo to filter the correct 80 cm modern and classic vanity sets and send detailed pricing.

The outbound gate will cancel safely if a newer customer message or an actionable Sale/Admin reply appears before send time.

A separate check is scheduled for 07:00 to verify actual send count, actual catalog identity, cancellations and errors without sending a duplicate recovery message.
