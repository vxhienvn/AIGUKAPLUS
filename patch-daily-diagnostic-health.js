import fs from "node:fs";

const file = "server-fixed.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_DAILY_DIAGNOSTIC_HEALTH_V1";
if (!source.includes(marker)) {
  const needle = "now: new Date().toISOString(),";
  if (!source.includes(needle)) throw new Error("DAILY_DIAGNOSTIC_HEALTH_ANCHOR_NOT_FOUND");
  source = source.replace(
    needle,
    `// ${marker}\n    daily_patch_error: process.env.AIGUKA_DAILY_PATCH_ERROR || null,\n    daily_null_safety_error: process.env.AIGUKA_DAILY_NULL_SAFETY_ERROR || null,\n    daily_integrity_error: process.env.AIGUKA_DAILY_INTEGRITY_ERROR || null,\n    now: new Date().toISOString(),`,
  );
  fs.writeFileSync(file, source, "utf8");
}
console.log("[AIGUKA] Temporary daily diagnostic health fields installed");
