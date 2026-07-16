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

const sourceBuffer = Buffer.from(payload.chunks.join(""), "base64");
const md5 = crypto.createHash("md5").update(sourceBuffer).digest("hex");
const expectedBytes = 23_115;
const expectedMd5 = "971b141fedd159796a7d57a1467aaf69";

if (sourceBuffer.length !== expectedBytes || md5 !== expectedMd5) {
  throw new Error(
    `V7_CODE_INTEGRITY_ERROR bytes=${sourceBuffer.length} md5=${md5}`,
  );
}

let source = sourceBuffer.toString("utf8");

const tokenDeclaration = 'const META_TOKEN = process.env.META_ACCESS_TOKEN || process.env.META_USER_ACCESS_TOKEN || process.env.FACEBOOK_USER_ACCESS_TOKEN || process.env.USER_ACCESS_TOKEN || "";';
if (!source.includes(tokenDeclaration)) {
  throw new Error("V7_META_TOKEN_DECLARATION_NOT_FOUND");
}
source = source.replace(
  tokenDeclaration,
  'const getMetaToken = () => process.env.META_ACCESS_TOKEN || process.env.META_USER_ACCESS_TOKEN || process.env.FACEBOOK_USER_ACCESS_TOKEN || process.env.USER_ACCESS_TOKEN || "";',
);
source = source.replaceAll("META_TOKEN", "getMetaToken()");

source = source.replaceAll(
  'selected = act(req.query.account) || "all"',
  'selected = String(req.query.account || "all") === "all" ? "all" : act(req.query.account)',
);
source = source.replaceAll(
  "selected=act(req.query.account)||'all'",
  "selected=String(req.query.account||'all')==='all'?'all':act(req.query.account)",
);

if (source.includes("account=act_all")) {
  source = source.replaceAll("account=act_all", "account=all");
}

if (!source.includes("/facebook-connect")) {
  source = source.replace(
    '<hr style="border-color:#334155">',
    '${nav(\'/facebook-connect\',\'🔐 Kết nối Facebook\',\'facebook\')}<hr style="border-color:#334155">',
  );
}

fs.writeFileSync("v7-dashboard-stable.js", source, "utf8");
console.log(
  `[AIGUKA] Stable V7 dashboard materialized: ${sourceBuffer.length} bytes · ${md5} · all-account filter fixed`,
);