import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "ai-dispatch-worker.js";
const marker = "AIGUKA_AI_BRAIN_INTERNAL_AUTH_V1";
let source = fs.readFileSync(file, "utf8");

if (source.includes(marker)) {
  console.log("[AIGUKA] AI Brain internal authentication already installed");
} else {
  source = source.replace(
    'const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";',
    'const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";\nconst BRAIN_SECRET = process.env.AIGUKA_V8_ADMIN_SECRET || process.env.META_VERIFY_TOKEN || ""; // AIGUKA_AI_BRAIN_INTERNAL_AUTH_V1',
  );
  source = source.replace(
    'authorization: `Bearer ${SERVICE_ROLE_KEY}`,\n      "content-type": "application/json",\n    },\n    body: JSON.stringify({ request_id: item.id }),',
    'authorization: `Bearer ${SERVICE_ROLE_KEY}`,\n      "x-aiguka-brain-secret": BRAIN_SECRET,\n      "content-type": "application/json",\n    },\n    body: JSON.stringify({ request_id: item.id }),',
  );
  source = source.replace(
    'const WORKER_VERSION = "profile_preflight_v2_authenticated_brain";',
    'const WORKER_VERSION = "profile_preflight_v3_internal_secret";',
  );
  if (!source.includes(marker)) throw new Error("AI_BRAIN_INTERNAL_AUTH_PATCH_FAILED");
  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`AI_BRAIN_INTERNAL_AUTH_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] AI Brain internal authentication installed");
}

await import("./patch-ai-followup-provider-fallback.js");
