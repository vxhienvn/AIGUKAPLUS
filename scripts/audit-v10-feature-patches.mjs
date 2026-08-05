import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const OUTPUT = path.join(ROOT, "docs", "V10_FEATURE_PATCH_EFFECTS.json");
const PATCHES = [
  "patch-learning-client.js",
  "patch-bot-page-mode-save.js",
  "patch-bot-page-support-mode.js",
  "patch-bot-clock-24h.js",
  "patch-ai-context-nav.js",
  "patch-ai-context-card-selection.js",
  "patch-ai-context-center-validation.js",
  "patch-meta-pages-messaging-scope.js",
  "patch-drive-v4-key-compat.js",
  "patch-drive-v4-api-key-folder-action.js",
  "patch-drive-folder-tree-hierarchy.js",
  "patch-catalog-key-rename.js",
  "patch-slide-generic-carousel.js",
  "patch-mapping-meta-midnight-delivery.js",
  "patch-outbound-human-takeover.js",
  "patch-outbound-comment-private-reply.js",
  "patch-outbound-binary-image-upload.js",
  "patch-outbound-drive-image-proxy-v2.js",
  "patch-outbound-marketing-notifications.js",
  "patch-ai-brain-internal-auth.js",
  "patch-ai-dispatch-profile-gender-preflight.js",
];

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function seedAudit() {
  const basePath = path.join(ROOT, "contexts", "tong-hop.md");
  const overridePath = path.join(ROOT, "contexts", "tong-hop-overrides.md");
  if (!fs.existsSync(basePath) || !fs.existsSync(overridePath)) {
    return {
      patch: "seed-tong-hop-context.js",
      classification: "operational_seed_missing_source",
      reason: "One or more context source files are missing.",
    };
  }
  const base = fs.readFileSync(basePath, "utf8").trim();
  const overrides = fs.readFileSync(overridePath, "utf8").trim();
  const content = `${base}\n\n${overrides}`;
  return {
    patch: "seed-tong-hop-context.js",
    classification: "operational_seed",
    reason: "May write application data; source hash is computed but the seed is not executed by this audit.",
    source_files: ["contexts/tong-hop.md", "contexts/tong-hop-overrides.md"],
    content_length: content.length,
    seed_hash: hashText(content),
  };
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AIGUKA_PATCH_AUDIT: "true",
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      SUPABASE_PUBLISHABLE_KEY: "",
      SUPABASE_ANON_KEY: "",
      AIGUKA_V9_CORE_URL: "",
      AIGUKA_V9_CORE_SERVICE_ROLE_KEY: "",
      META_ACCESS_TOKEN: "",
    },
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

function listedFiles() {
  const result = command("git", ["ls-files", "--cached", "--others", "--exclude-standard"]);
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\n").map((item) => item.trim()).filter(Boolean)
    .filter((item) => item !== "docs/V10_FEATURE_PATCH_EFFECTS.json");
}

function snapshot() {
  const hashes = new Map();
  for (const relative of listedFiles()) {
    const absolute = path.join(ROOT, relative);
    let stat;
    try { stat = fs.statSync(absolute); } catch { continue; }
    if (!stat.isFile()) continue;
    const bytes = fs.readFileSync(absolute);
    hashes.set(relative, crypto.createHash("sha256").update(bytes).digest("hex"));
  }
  return hashes;
}

function changedFiles(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

const baseline = command("git", ["status", "--porcelain"]);
if (baseline.status !== 0) throw new Error(`git status failed: ${baseline.stderr}`);
if (baseline.stdout) throw new Error(`Audit requires clean checkout, found:\n${baseline.stdout}`);

const results = [];
for (const patch of PATCHES) {
  if (!fs.existsSync(path.join(ROOT, patch))) {
    results.push({ patch, classification: "missing", status: 127, changed_files: [], stderr: "file missing" });
    continue;
  }
  const before = snapshot();
  const run = command(process.execPath, [patch]);
  const after = snapshot();
  const files = changedFiles(before, after);
  results.push({
    patch,
    classification: run.status !== 0 ? "failed" : files.length ? "effective_source_patch" : "no_source_effect",
    status: run.status,
    changed_files: files,
    stdout: run.stdout.slice(0, 1500),
    stderr: run.stderr.slice(0, 1500),
  });
}

const report = {
  generated_at: new Date().toISOString(),
  branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || null,
  method: "Sequential clean-checkout source hash comparison. Operational data seeds are not executed.",
  results,
  skipped: [seedAudit()],
  summary: {
    total_source_patches: results.length,
    effective_source_patches: results.filter((item) => item.classification === "effective_source_patch").length,
    no_source_effect: results.filter((item) => item.classification === "no_source_effect").length,
    failed: results.filter((item) => item.classification === "failed").length,
    missing: results.filter((item) => item.classification === "missing").length,
  },
};

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report.summary));
for (const item of results) {
  console.log(`${item.classification.padEnd(24)} ${item.patch} ${item.changed_files.join(", ")}`);
}
console.log(`operational_seed_hash      ${report.skipped[0].seed_hash || "unavailable"}`);
