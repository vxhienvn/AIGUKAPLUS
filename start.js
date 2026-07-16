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
await import("./materialize-v7-dashboard.js");
await import("./patch-v7-product-detection.js");
await import("./patch-v7-navigation.js");
await import("./patch-v7-lead-filters.js");
await import("./patch-learning-client.js");
await import("./patch-server.js");
await import("./server-fixed.js");