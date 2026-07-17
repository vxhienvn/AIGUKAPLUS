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
  ["dailyPage", /async\s+function\s+dailyPage\s*\(/g],
  ["leadsPage", /async\s+function\s+leadsPage\s*\(/g],
];

for (const [name, pattern] of required) {
  const count = [...source.matchAll(pattern)].length;
  if (count !== 1) {
    throw new Error(`V7_RUNTIME_INTEGRITY_${name.toUpperCase()}_COUNT_${count}`);
  }
}

const dailyLoaderStart = source.indexOf("async function fetchMetaFirstCustomerStarts");
const dailyPageStart = source.indexOf("async function dailyPage", dailyLoaderStart);
const referralLoaderStart = source.indexOf("async function fetchMetaAdReferralEntries", dailyPageStart);
const resolveStart = source.indexOf("async function resolveLeadAdMap", referralLoaderStart);
const leadLoaderStart = source.indexOf("async function loadUnifiedLeadReport", resolveStart);
const leadsPageStart = source.indexOf("async function leadsPage", leadLoaderStart);
const installStart = source.indexOf("export function installStableV7Dashboard");

if (
  dailyLoaderStart < 0 ||
  dailyPageStart <= dailyLoaderStart ||
  referralLoaderStart <= dailyPageStart ||
  resolveStart <= referralLoaderStart ||
  leadLoaderStart <= resolveStart ||
  leadsPageStart <= leadLoaderStart ||
  installStart <= leadsPageStart
) {
  throw new Error("V7_RUNTIME_INTEGRITY_FUNCTION_ORDER_INVALID");
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
  unifiedLoader.includes("fetchMetaConversationStarts(p.since, p.until)")
) {
  throw new Error("V7_RUNTIME_INTEGRITY_UNIFIED_LEAD_SOURCE_INVALID");
}

const knownCalls = [
  ["shiftLeadDate", /\bshiftLeadDate\s*\(/],
  ["loadUnifiedLeadReport", /\bloadUnifiedLeadReport\s*\(/],
  ["resolveLeadAdMap", /\bresolveLeadAdMap\s*\(/],
  ["leadIdentity", /\bleadIdentity\s*\(/],
];
for (const [name, callPattern] of knownCalls) {
  if (callPattern.test(source) && !required.find(([requiredName]) => requiredName === name)) {
    throw new Error(`V7_RUNTIME_INTEGRITY_${name.toUpperCase()}_UNTRACKED`);
  }
}

const syntax = spawnSync(process.execPath, ["--check", file], {
  encoding: "utf8",
});
if (syntax.status !== 0) {
  throw new Error(`V7_RUNTIME_INTEGRITY_SYNTAX:${syntax.stderr || syntax.stdout}`);
}

console.log("[AIGUKA] V7 dashboard runtime integrity verified with exact Meta view-column pairs");
