import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");

const replacements = [
  ["...(data.errors||[])", "...((data?.errors)||[])"],
  ["...(ads.errors||[])", "...((ads?.errors)||[])"],
  ["...(meta.errors || [])", "...((meta?.errors) || [])"],
  ["...(report.meta.errors || [])", "...((report.meta?.errors) || [])"],
  ["...(firstStarts.error?[firstStarts.error]:[])", "...(firstStarts?.error?[firstStarts.error]:[])"],
  ["...(pancake.error?[pancake.error]:[])", "...(pancake?.error?[pancake.error]:[])"],
  ["...(pancake.error ? [pancake.error] : [])", "...(pancake?.error ? [pancake.error] : [])"],
  ["...(metaCustomers.error ? [metaCustomers.error] : [])", "...(metaCustomers?.error ? [metaCustomers.error] : [])"],
  ["...(report.referrals.error ? [report.referrals.error] : [])", "...(report.referrals?.error ? [report.referrals.error] : [])"],
  ["...(report.starts.error ? [report.starts.error] : [])", "...(report.starts?.error ? [report.starts.error] : [])"],
  ["...(report.referrals?.error?[report.referrals.error]:[])", "...(report.referrals?.error?[report.referrals.error]:[])"],
];

for (const [needle, replacement] of replacements) {
  source = source.replaceAll(needle, replacement);
}

// Chặn trực tiếp các mẫu đọc .error không an toàn trong hai route đang vận hành.
const dailyStart = source.indexOf("async function dailyPage(req,res)");
const leadsStart = source.indexOf("async function leadsPage(req,res)");
const installStart = source.indexOf("export function installStableV7Dashboard");
if (dailyStart < 0 || leadsStart < 0 || installStart < 0) {
  throw new Error("V7_NULL_SAFETY_ROUTE_ANCHOR_NOT_FOUND");
}

const dailyBlock = source.slice(dailyStart, leadsStart);
const leadsBlock = source.slice(leadsStart, installStart);
const unsafePatterns = [
  /\bdata\.errors\b/,
  /\bads\.errors\b/,
  /\bfirstStarts\.error\b/,
  /\bpancake\.error\b/,
  /\breport\.referrals\.error\b/,
  /\breport\.starts\.error\b/,
  /\bmetaCustomers\.error\b/,
];

for (const pattern of unsafePatterns) {
  const dailyUnsafe = pattern.test(dailyBlock) && !dailyBlock.match(new RegExp(pattern.source.replace("\\.", "\\?\\.")));
  const leadsUnsafe = pattern.test(leadsBlock) && !leadsBlock.match(new RegExp(pattern.source.replace("\\.", "\\?\\.")));
  if (dailyUnsafe || leadsUnsafe) {
    throw new Error(`V7_NULL_SAFETY_UNSAFE_ERROR_READ:${pattern}`);
  }
}

fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] Daily and Leads error reads are null-safe");
