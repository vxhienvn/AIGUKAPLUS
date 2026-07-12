import fs from "node:fs";
import crypto from "node:crypto";

const supabaseUrl = String(
  process.env.SUPABASE_URL || "https://ezygfpeeqbbirdeazene.supabase.co",
).replace(/\/$/, "");
const publishableKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "";

if (!publishableKey) {
  throw new Error("MISSING_SUPABASE_PUBLISHABLE_KEY");
}

const response = await fetch(
  `${supabaseUrl}/rest/v1/rpc/v8_get_embedded_code_test`,
  {
    method: "POST",
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${publishableKey}`,
      "content-type": "application/json",
      "x-aiguka-railway-test": "enabled",
      "x-aiguka-admin-secret": "AIGUKA_RAILWAY_TEST_MODE",
    },
    body: JSON.stringify({ p_code_key: "v7_dashboard_stable" }),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  },
);

const payload = await response.json().catch(() => ({}));
if (!response.ok || !payload?.ok || !Array.isArray(payload?.chunks)) {
  throw new Error(
    payload?.message || payload?.error || `V7_CODE_HTTP_${response.status}`,
  );
}

const source = Buffer.from(payload.chunks.join(""), "base64");
const md5 = crypto.createHash("md5").update(source).digest("hex");
const expectedBytes = 23_115;
const expectedMd5 = "971b141fedd159796a7d57a1467aaf69";

if (source.length !== expectedBytes || md5 !== expectedMd5) {
  throw new Error(
    `V7_CODE_INTEGRITY_ERROR bytes=${source.length} md5=${md5}`,
  );
}

fs.writeFileSync("v7-dashboard-stable.js", source);
console.log(
  `[AIGUKA] Stable V7 dashboard materialized: ${source.length} bytes · ${md5}`,
);