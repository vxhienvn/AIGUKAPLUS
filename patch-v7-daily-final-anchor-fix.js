import fs from "node:fs";

const file = "patch-v7-daily-final.js";
let source = fs.readFileSync(file, "utf8");
const oldAnchor = `  const start = source.indexOf("async function dailyPage(req,res)");
  let end = source.indexOf("async function fetchMetaAdReferralEntries", start);
  if (end < 0) end = source.indexOf("async function leadsPage(req,res)", start);
  if (start < 0 || end < 0) throw new Error("DAILY_FINAL_ROUTE_ANCHOR_NOT_FOUND");`;
const newAnchor = `  const start = source.indexOf("async function dailyPage(req,res)");
  // Lead helpers (shiftLeadDate, leadIdentity, referral loader...) are inserted
  // immediately after dailyPage. Stop at their marker so Daily never deletes them.
  let end = source.indexOf("// AIGUKA_META_PRIMARY_LEADS_V2", start);
  if (end < 0) end = source.indexOf("function shiftLeadDate", start);
  if (end < 0) end = source.indexOf("async function fetchMetaAdReferralEntries", start);
  if (start < 0 || end < 0 || end <= start) throw new Error("DAILY_FINAL_ROUTE_ANCHOR_NOT_FOUND");`;
if (!source.includes(newAnchor)) {
  if (!source.includes(oldAnchor)) throw new Error("DAILY_FINAL_ANCHOR_PATCH_NOT_FOUND");
  source = source.replace(oldAnchor, newAnchor);
  fs.writeFileSync(file, source, "utf8");
}
console.log("[AIGUKA] Daily final patch restricted to dailyPage; Lead helpers preserved");
