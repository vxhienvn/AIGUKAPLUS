import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_LEAD_FILTER_DATASET_FIX_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Lead filter datasets already repaired");
} else {
  if (!source.includes("AIGUKA_SPLIT_LEADS_AD_PERFORMANCE_V1")) {
    throw new Error("LEAD_FILTER_DATASET_FIX_REQUIRES_SPLIT_LEADS");
  }
  if (!source.includes("AIGUKA_LEAD_LOGICAL_FILTER_V1")) {
    throw new Error("LEAD_FILTER_DATASET_FIX_REQUIRES_LOGICAL_FILTER");
  }

  const rowNeedle = `return '<tr class="lead-ad-row" data-customer="'+esc(group.name)+'" data-customer-key="'+esc(group.customerKey)+'" data-contact="'+esc(contact)+'" data-account="'+esc(x.accountName||'')+'" data-ad="'+esc(x.adName||'')+'" data-product="'+esc(x.product||'')+'">'`;
  const rowReplacement = `return '<tr class="lead-ad-row" data-customer="'+esc(group.name)+'" data-customer-key="'+esc(group.customerKey)+'" data-contact="'+esc(contact)+'" data-account="'+esc(x.accountName||'')+'" data-campaign="'+esc(x.campaignName||'')+'" data-adset="'+esc(x.adsetName||'')+'" data-ad="'+esc(x.adName||'')+'" data-product="'+esc(x.product||'')+'" data-source="'+esc(x.source_type||'')+'" data-tags="'+esc((x.tags||[]).join(', '))+'">'`;
  if (!source.includes(rowNeedle)) {
    throw new Error("LEAD_FILTER_DATASET_FIX_ROW_ANCHOR_NOT_FOUND");
  }
  source = source.replace(rowNeedle, rowReplacement);

  const groupNeedle = "rows.forEach(row=>{const key=row.dataset.customer||String(rows.indexOf(row));if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)});";
  const groupReplacement = "rows.forEach(row=>{const key=row.dataset.customerKey||row.dataset.customer||String(rows.indexOf(row));if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)});";
  if (!source.includes(groupNeedle)) {
    throw new Error("LEAD_FILTER_DATASET_FIX_GROUP_ANCHOR_NOT_FOUND");
  }
  source = source.replace(groupNeedle, groupReplacement);

  source = source.replace("</body>", `<!-- ${marker} --></body>`);
  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) {
    throw new Error(`LEAD_FILTER_DATASET_FIX_SYNTAX:${syntax.stderr || syntax.stdout}`);
  }
  console.log("[AIGUKA] Campaign, Ad set, source and Pancake tag filters now read logical row datasets");
}
