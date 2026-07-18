import { loadActiveMetaConnection } from "./meta-token-store.js";

try {
  const connection = await loadActiveMetaConnection();
  if (connection?.accessToken) {
    process.env.META_ACCESS_TOKEN = connection.accessToken;
    process.env.META_AUTO_AD_ACCOUNTS = process.env.META_AUTO_AD_ACCOUNTS || "true";
    console.log(
      `[AIGUKA] Loaded Meta OAuth connection for ${connection.facebookUserName || connection.facebookUserId}`,
    );
  } else {
    console.log("[AIGUKA] No saved Meta OAuth connection; using Railway variables");
  }
} catch (error) {
  console.error("[AIGUKA] Could not load saved Meta OAuth connection:", error.message);
}

await import("./patch-v7-pancake-classifier.js");
await import("./patch-v7-pancake-history.js");
await import("./patch-v7-pancake-tag-parser.js");
await import("./materialize-v7-dashboard.js");
await import("./patch-v7-report-accuracy.js");
await import("./patch-v7-product-detection.js");
await import("./patch-v7-navigation.js");
await import("./patch-v7-pancake-toggle.js");
await import("./patch-v7-lead-filters.js");
await import("./patch-v7-daily-grouped.js");
await import("./patch-v7-daily-staff-history.js");
await import("./patch-v7-daily-layout-sample.js");
await import("./patch-v7-filter-final.js");

await import("./patch-v7-daily-staff-aligned.js");
await import("./patch-v7-daily-runtime-self-contained.js");
await import("./patch-v7-leads-meta-primary.js");
await import("./patch-v7-leads-referral-source.js");
await import("./patch-v7-pancake-tag-completeness.js");
await import("./patch-v7-pancake-tag-final.js");
await import("./patch-v7-daily-final-anchor-fix.js");
await import("./patch-v7-daily-final.js");
await import("./patch-v7-lead-table-v4.js");
await import("./patch-v7-lead-filter-logical.js");
await import("./patch-v7-lead-contact-ui.js");
await import("./patch-v7-null-safety.js");
await import("./patch-v7-runtime-integrity.js");

await import("./patch-learning-client.js");
await import("./patch-bot-page-mode-save.js");
await import("./patch-bot-clock-24h.js");
await import("./patch-ai-context-nav.js");
await import("./patch-ai-context-center-validation.js");
await import("./patch-server.js");
await import("./server-fixed.js");
