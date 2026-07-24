# Lead account reconciliation acceptance

For 2026-07-23, filtering ad account `311242249583664` (Nguyệt Bếp-TB Vệ Sinh) must show exactly 6 advertising customers, matching Meta Ads Insights.

Rules:
- Keep exact ad attribution when referral/ad_id exists.
- Fill only the account-level identity deficit from `v8_meta_customer_leads_daily` using the primary Page → ad-account mapping.
- Never exceed the Meta account total.
- Leave Campaign, Ad set and Ad blank when evidence is insufficient.
- Include customers from active, paused and previously stopped ads.
