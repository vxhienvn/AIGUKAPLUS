# Live reply recovery — 2026-07-24

Case: Hien Hc-kt, Page 104810069068200.

Root causes fixed:

1. Meta click-to-call companion text (`Hãy gọi ngay để được phục vụ nhanh hơn.`) was an unresolved Page outbound and cancelled AIGUKAPLUS as `EXTERNAL_RESPONDER_REPLIED`.
2. `v8_claim_outbound_batch` ran global SLA and ready-queue reconciliation inside every four-second live poll. Supabase timeouts could therefore stop all ready replies before claim.

Production behavior after the fix:

- Known Meta call CTAs are non-blocking Page automation.
- The live claim path evaluates only due rows.
- The final outbound authorization and transport confirmation gates remain mandatory before Meta delivery.
- The deterministic combo postback response remains zero-token.
