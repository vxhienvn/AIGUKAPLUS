# AIGUKA — AI authority and conversation learning repair (2026-07-22)

## Scope

Production Supabase project: `ezygfpeeqbbirdeazene`

Pages reviewed:

- GUKA — `985632314640803`
- Tổng Kho Thiết Bị Bếp & Nhà Tắm Miền Bắc — `104810069068200`

## Owner-verified learning cases

### Ngân Nguyên — GUKA

The customer was discussing both a bathroom combo and a toilet. The owner’s effective close was:

> Dạ với phòng trọ bên em có combo hơn 3 triệu. Bồn trứng và bồn liền khối bên em có nhiều mẫu. Chị cho em xin SĐT để em trao đổi và tư vấn cho tiện chị nhé.

The final contact request was the conversion point. The approved learning case now teaches the AI to provide one or two short pieces of useful information, then ask directly for the phone/Zalo instead of continuing with many product questions. The price example is owner-verified for this context and must not be generalized without evidence.

### Thương Lê — GUKA

Observed failures:

- The customer requested a wall-mounted vanity cabinet with basin, width 80 cm.
- The customer requested both modern and neoclassical styles and later asked about an electronic mirror.
- The system sent two loose lavabo-basin images from catalog `lavabo`, not cabinet-and-basin images from `guong_tu`.
- The bot incorrectly claimed the sent images were wall-mounted 80 cm vanity cabinets.
- The customer self-referred as `anh`, but the bot kept using `anh/chị`.
- The follow-up scanner raced the unresolved primary AI slide decision.

The approved learning case teaches the AI to read the full conversation, distinguish a loose basin from a vanity cabinet set, avoid asking questions already answered, acknowledge and correct a wrong image, prioritize a concise contact request, and use direct self-reference as stronger salutation evidence than a name or avatar.

## Production changes

### AI remains the final decision-maker

Business-language checks for salutation, event wording, price/inventory claims and slide count/catalog consistency are recorded as advisories to AI rather than template rewrites. Legacy/template automation can still retain a price firewall, while AI-authority reply plans preserve the AI wording.

Hard technical controls remain for runtime OFF/OBSERVE/TEST, recipient allowlists, messaging-window eligibility, stale customer turns, duplicate sends and unusable image delivery.

### Salutation

- Name-based gender persistence was disabled.
- Previously persisted `name_inference_high_confidence` values were cleared.
- Unknown salutation uses `bạn` or neutral wording.
- Direct customer self-reference in the conversation is the preferred evidence.
- Thương Lê was corrected to `anh` with source `conversation_self_reference`.
- AI-authority reply plans are no longer rewritten by the salutation personalizer; resolved salutation is attached only as advisory evidence.

### Product and slide routing

High-priority aliases were added to catalog `guong_tu` for:

- `tủ lavabo`
- `tủ chậu lavabo`
- `bộ tủ chậu lavabo`
- `tủ lavabo treo`
- `tủ treo lavabo`
- `tủ chậu treo 80`
- `gương điện tử`
- `tủ lavabo kèm gương điện tử`
- common `tủ treo 80` and typo variants

The exact message `Tu treo kich thuob 80` now resolves to:

- group: `lavabo_tu_lavabo`
- catalog/root product: `guong_tu`
- folder: `PHÒNG TẮM/GƯƠNG-TỦ`

`v8_select_slide_assets` now prioritizes an explicit catalog over a possibly broader root/group key and returns only verified assets. A lookup with root `lavabo_tu_lavabo` and catalog `guong_tu` returns ten verified `guong_tu` assets rather than loose `lavabo` images.

### Follow-up race

A before-insert guard on `v8_ai_brain_requests` suppresses premature follow-up creation while:

- the latest inbound is less than 10 minutes old;
- the primary AI request is pending/processing; or
- the primary AI decision is awaiting revision/review.

This prevents the scheduled follow-up brain from speaking over an unresolved primary AI response.

### Conversation memory

Thương Lê’s AI memory was corrected to reflect actual delivery: two wrong loose-basin images were sent, not ten correct vanity-cabinet images. Pending actions now require acknowledging the mistake, sending the correct cabinet-and-basin samples and requesting phone/Zalo concisely.

## Monitoring

The hourly monitor and 10-hour report were updated to inspect each conversation’s actual message timeline, AI decision, reply plan, slide assets and outbound queue. They explicitly check for:

- rules/templates/follow-up overriding AI authority;
- asset catalog mismatch;
- false claims about images already sent;
- repeated questions already answered by the customer;
- generic `anh/chị` and name-based misgendering;
- the Ngân Nguyên contact-close lesson;
- the Thương Lê vanity-cabinet lesson.
