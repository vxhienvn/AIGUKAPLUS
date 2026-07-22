# Dynamic AI Follow-up V8

## Purpose

Replace the fixed Ver7 eight-hour follow-up with a context-aware schedule while keeping AI as the final decision-maker.

## Timing policy

All times use `Asia/Bangkok` / Vietnam time.

| Anchor time | Hot/sample/contact request | General lead |
|---|---:|---:|
| 08:00–17:59 | 4 hours | 5 hours |
| 18:00–21:59 | 2 hours | 3 hours |
| 22:00–07:59 | Resume at 08:15 | Resume at 08:15 |

A follow-up scan only makes a case eligible for AI review. AI may still decline to send.

## Requested-slide recovery

When a customer explicitly requested samples, has not supplied phone/Zalo, and Admin/Sale only requested contact details without sending the requested samples:

1. The database resolves the requested catalog(s).
2. It prepares up to ten active, verified assets.
3. Multi-product requests are balanced round-robin across catalogs.
4. The Follow-up Brain receives the conversation, customer profile, memory, slide context and candidate asset metadata.
5. AI can choose `action_type=follow_up_with_requested_slides`.
6. The execution layer revalidates the assets, stages the text and carousel, and retains safety gates for newer messages, human takeover, messaging window and verified delivery URLs.

The database does not force a slide. It only stages one when AI explicitly selects the slide action.

## Event benefits

For the Tổng Kho page, AI may mention up to two short, relevant and non-repeated benefits:

- gifts depending on the order/program;
- travel support when the customer visits the showroom and places an order/deposit, depending on distance.

Unverified amounts, prices, gift values, delivery ranges and guarantees remain prohibited.

## Production migrations

Applied to Supabase project `ezygfpeeqbbirdeazene`:

- `dynamic_follow_up_schedule`
- `follow_up_prepare_slide_context`
- `follow_up_stage_slide_decision`
- `dynamic_follow_up_policy_guidance`

## Verified scenario: Nguyễn Hằng

- Customer request: chậu–vòi plus bếp từ–máy hút mùi samples.
- Admin contact request: 18:04:53 on 22 July 2026.
- Dynamic eligibility: 20:04:53 on 22 July 2026, provided there is no newer customer/Admin/Sale activity and no contact information is received.
- Prepared carousel: 10 verified cards, balanced 5 + 5 across the two requested catalogs.
