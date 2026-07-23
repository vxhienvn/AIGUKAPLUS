import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const metaMarker = "AIGUKA_LEAD_META_INSIGHTS_TRUTH_V1";
const attributionMarker = "AIGUKA_LEAD_REEL_OLD_AD_ATTRIBUTION_V1";
const performanceAnchor = "function buildMetaAdPerformance(report) {";

if (source.includes(metaMarker)) {
  console.log("[AIGUKA] Meta Insights marker already available for split pages");
} else if (source.includes(attributionMarker) && source.includes(performanceAnchor)) {
  source = source.replace(
    performanceAnchor,
    `// ${metaMarker}\n${performanceAnchor}`,
  );
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA] Restored Meta Insights compatibility marker after old-ad attribution");
} else {
  throw new Error("SPLIT_LEADS_COMPAT_PERFORMANCE_ANCHOR_NOT_FOUND");
}
