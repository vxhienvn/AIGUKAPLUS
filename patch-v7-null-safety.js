import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");

const directReads = [
  ["report.referrals.error", "report.referrals?.error"],
  ["report.starts.error", "report.starts?.error"],
  ["report.pancake.error", "report.pancake?.error"],
  ["report.meta.errors", "report.meta?.errors"],
  ["metaCustomers.error", "metaCustomers?.error"],
  ["firstStarts.error", "firstStarts?.error"],
  ["pancake.error", "pancake?.error"],
  ["data.errors", "data?.errors"],
  ["ads.errors", "ads?.errors"],
  ["meta.errors", "meta?.errors"],
];

for (const [needle, replacement] of directReads) {
  source = source.replaceAll(needle, replacement);
}

const dailyStart = source.indexOf("async function dailyPage(req,res)");
const leadsStart = source.indexOf("async function leadsPage(req,res)");
const installStart = source.indexOf("export function installStableV7Dashboard");
if (dailyStart < 0 || leadsStart < 0 || installStart < 0) {
  throw new Error("V7_NULL_SAFETY_ROUTE_ANCHOR_NOT_FOUND");
}

const routeBlock = source.slice(dailyStart, installStart);
const forbidden = [
  "report.referrals.error",
  "report.starts.error",
  "report.pancake.error",
  "report.meta.errors",
  "metaCustomers.error",
  "firstStarts.error",
  "pancake.error",
  "data.errors",
  "ads.errors",
  "meta.errors",
];
for (const value of forbidden) {
  if (routeBlock.includes(value)) {
    throw new Error("V7_NULL_SAFETY_DIRECT_READ_REMAINS:" + value);
  }
}

fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] Daily and Leads error reads are null-safe");
