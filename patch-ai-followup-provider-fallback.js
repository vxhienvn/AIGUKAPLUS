import fs from "node:fs";

const providerFile = "ai-follow-up-provider.js";
let providerSource = fs.readFileSync(providerFile, "utf8");
const providerMarker = "AIGUKA_GEMINI_FOLLOW_UP_JSON_STABILITY_V1";
if (!providerSource.includes(providerMarker)) {
  providerSource = providerSource.replace(
    'const model = String(provider.model_name || "gemini-2.5-flash").replace(/^models\\//, "");',
    'const model = "gemini-2.0-flash"; // AIGUKA_GEMINI_FOLLOW_UP_JSON_STABILITY_V1',
  );
  providerSource = providerSource.replace(
    'maxOutputTokens: 500,',
    'maxOutputTokens: 1200,',
  );
  if (!providerSource.includes(providerMarker)) throw new Error("GEMINI_FOLLOW_UP_JSON_PATCH_FAILED");
  fs.writeFileSync(providerFile, providerSource, "utf8");
  console.log("[AIGUKA] Stabilized Gemini follow-up JSON output");
}

const file = "ai-dispatch-worker.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_AI_FOLLOW_UP_PROVIDER_FALLBACK_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] AI follow-up provider fallback already installed");
} else {
  const importLine = 'import crypto from "node:crypto";';
  if (!source.includes(importLine)) throw new Error("FOLLOW_UP_FALLBACK_IMPORT_ANCHOR_NOT_FOUND");
  source = source.replace(
    importLine,
    `${importLine}\nimport { dispatchFollowUpWithFallback } from "./ai-follow-up-provider.js";\n// ${marker}`,
  );

  const start = source.indexOf("async function dispatchFollowUp(item) {");
  const end = source.indexOf("\nasync function dispatchBrain(item) {", start);
  if (start < 0 || end < 0) throw new Error("FOLLOW_UP_FALLBACK_FUNCTION_ANCHOR_NOT_FOUND");
  source = source.slice(0, start)
    + `async function dispatchFollowUp(item) {\n  return dispatchFollowUpWithFallback(item);\n}\n`
    + source.slice(end);

  source = source.replace(
    'const WORKER_VERSION = "profile_preflight_v4_direct_ai_follow_up";',
    'const WORKER_VERSION = "profile_preflight_v6_gemini_json_fallback";',
  );

  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA] Installed AI follow-up provider fallback");
}
