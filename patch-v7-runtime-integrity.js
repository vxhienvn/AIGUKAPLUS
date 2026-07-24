import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-dashboard-stable.js";
const source = fs.readFileSync(file, "utf8");

const required = [
  ["shiftLeadDate", /function\s+shiftLeadDate\s*\(/g],
  ["leadIdentity", /function\s+leadIdentity\s*\(/g],
  ["fetchMetaFirstCustomerStarts", /async\s+function\s+fetchMetaFirstCustomerStarts\s*\(/g],
  ["fetchMetaAdReferralEntries", /async\s+function\s+fetchMetaAdReferralEntries\s*\(/g],
  ["resolveLeadAdMap", /async\s+function\s+resolveLeadAdMap\s*\(/g],
  ["loadUnifiedLeadReport", /async\s+function\s+loadUnifiedLeadReport\s*\(/g],
  ["dashboardPage", /async\s+function\s+dashboardPage\s*\(/g],
  ["dailyPage", /async\s+function\s+dailyPage\s*\(/g],
  ["leadsPage", /async\s+function\s+leadsPage\s*\(/g],
];

for (const [name, pattern] of required) {
  const count = [...source.matchAll(pattern)].length;
  if (count !== 1) {
    throw new Error(`V7_RUNTIME_INTEGRITY_${name.toUpperCase()}_COUNT_${count}`);
  }
}

const dashboardStart = source.indexOf("async function dashboardPage");
const dailyLoaderStart = source.indexOf("async function fetchMetaFirstCustomerStarts");
const dailyPageStart = source.indexOf("async function dailyPage", dailyLoaderStart);
const referralLoaderStart = source.indexOf("async function fetchMetaAdReferralEntries", dailyPageStart);
const resolveStart = source.indexOf("async function resolveLeadAdMap", referralLoaderStart);
const leadLoaderStart = source.indexOf("async function loadUnifiedLeadReport", resolveStart);
const leadsPageStart = source.indexOf("async function leadsPage", leadLoaderStart);
const installStart = source.indexOf("export function installStableV7Dashboard");

if (
  dashboardStart < 0 ||
  dailyLoaderStart <= dashboardStart ||
  dailyPageStart <= dailyLoaderStart ||
  referralLoaderStart <= dailyPageStart ||
  resolveStart <= referralLoaderStart ||
  leadLoaderStart <= resolveStart ||
  leadsPageStart <= leadLoaderStart ||
  installStart <= leadsPageStart
) {
  throw new Error("V7_RUNTIME_INTEGRITY_FUNCTION_ORDER_INVALID");
}

const dashboardBlock = source.slice(dashboardStart, dailyLoaderStart);
if (dashboardBlock.includes("pancake.error") || dashboardBlock.includes("meta.errors")) {
  throw new Error("V7_RUNTIME_INTEGRITY_DASHBOARD_UNSAFE_ERROR_READ");
}

const dailyLoader = source.slice(dailyLoaderStart, dailyPageStart);
if (dailyLoader.includes("META_LEADS_SUPABASE_URL") || dailyLoader.includes("META_LEADS_SUPABASE_KEY")) {
  throw new Error("V7_RUNTIME_INTEGRITY_DAILY_EXTERNAL_SUPABASE_BINDING");
}
if (!dailyLoader.includes("dailySupabaseUrl") || !dailyLoader.includes("dailySupabaseKey")) {
  throw new Error("V7_RUNTIME_INTEGRITY_DAILY_LOCAL_SUPABASE_BINDING_MISSING");
}
if (
  !dailyLoader.includes("/rest/v1/v8_meta_conversation_starts?") ||
  !dailyLoader.includes('params.append("conversation_started_at",') ||
  dailyLoader.includes("/rest/v1/v8_meta_ad_referral_entries?")
) {
  throw new Error("V7_RUNTIME_INTEGRITY_DAILY_META_VIEW_COLUMN_MISMATCH");
}

const dailyBlock = source.slice(dailyPageStart, referralLoaderStart);
for (const unsafe of ["data.errors", "ads.errors", "firstStarts.error", "pancake.error"]) {
  if (dailyBlock.includes(unsafe)) {
    throw new Error("V7_RUNTIME_INTEGRITY_DAILY_UNSAFE_ERROR_READ:" + unsafe);
  }
}

const referralLoader = source.slice(referralLoaderStart, resolveStart);
if (
  !referralLoader.includes("/rest/v1/v8_meta_ad_referral_entries?") ||
  !referralLoader.includes('params.append("referral_at",') ||
  referralLoader.includes('params.append("conversation_started_at",')
) {
  throw new Error("V7_RUNTIME_INTEGRITY_LEAD_REFERRAL_VIEW_COLUMN_MISMATCH");
}

const unifiedLoader = source.slice(leadLoaderStart, leadsPageStart);
if (
  !unifiedLoader.includes("fetchMetaAdReferralEntries(p.since, p.until)") ||
  !unifiedLoader.includes("const [accounts, meta, pancake, referrals]") ||
  !unifiedLoader.includes("referrals,") ||
  unifiedLoader.includes("fetchMetaConversationStarts(p.since, p.until)") ||
  unifiedLoader.includes("starts,")
) {
  throw new Error("V7_RUNTIME_INTEGRITY_UNIFIED_LEAD_SOURCE_INVALID");
}

const leadsPageBlock = source.slice(leadsPageStart, installStart);
if (
  !leadsPageBlock.includes("report.referrals?.error") ||
  leadsPageBlock.includes("report.starts.error") ||
  leadsPageBlock.includes("report.starts?.error") ||
  leadsPageBlock.includes("report.referrals.error") ||
  leadsPageBlock.includes("report.pancake.error") ||
  leadsPageBlock.includes("report.meta.errors")
) {
  throw new Error("V7_RUNTIME_INTEGRITY_LEADS_REPORT_PROPERTY_OR_NULL_SAFETY_INVALID");
}

const syntax = spawnSync(process.execPath, ["--check", file], {
  encoding: "utf8",
});
if (syntax.status !== 0) {
  throw new Error(`V7_RUNTIME_INTEGRITY_SYNTAX:${syntax.stderr || syntax.stdout}`);
}

// Verify real Supabase schemas before serving traffic. A deterministic 4xx means
// the schema is wrong and must still fail startup. Network timeouts and Supabase
// 5xx responses are transient: retry them, report degraded startup, but do not
// take the entire bot and outbound worker offline.
const supabaseUrl = String(
  process.env.SUPABASE_URL || "https://ezygfpeeqbbirdeazene.supabase.co",
).replace(/\/$/, "");
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function verifySchemaEndpoint(label, view, column) {
  const params = new URLSearchParams({ select: column, limit: "1" });
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/${view}?${params.toString()}`, {
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
        },
        signal: AbortSignal.timeout(8_000),
        cache: "no-store",
      });

      if (response.ok) return true;

      const detail = await response.text().catch(() => "");
      if (response.status >= 400 && response.status < 500) {
        throw new Error(
          `V7_RUNTIME_SCHEMA_${label.toUpperCase()}_${response.status}:${detail.slice(0, 300)}`,
        );
      }
      lastError = new Error(`SUPABASE_TRANSIENT_${response.status}:${detail.slice(0, 200)}`);
    } catch (error) {
      if (String(error?.message || "").startsWith("V7_RUNTIME_SCHEMA_")) throw error;
      lastError = error;
    }

    if (attempt < 3) await sleep(500 * attempt);
  }

  console.warn(
    `[AIGUKA] Supabase schema check ${label} deferred after transient failure: ${String(lastError?.message || lastError).slice(0, 300)}`,
  );
  return false;
}

let onlineSchemaChecks = 0;
if (supabaseKey) {
  const schemaChecks = [
    ["daily_first_start", "v8_meta_conversation_starts", "conversation_started_at"],
    ["lead_ad_referral", "v8_meta_ad_referral_entries", "referral_at"],
  ];
  for (const [label, view, column] of schemaChecks) {
    if (await verifySchemaEndpoint(label, view, column)) onlineSchemaChecks += 1;
  }
}

console.log(
  `[AIGUKA] V7 runtime integrity verified; online Supabase schema checks ${onlineSchemaChecks}/2`,
);