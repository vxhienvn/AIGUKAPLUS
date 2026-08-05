import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

const start = fs.readFileSync("start.js", "utf8");
const audit = JSON.parse(fs.readFileSync("docs/V10_FEATURE_PATCH_EFFECTS.json", "utf8"));

const ACTIVE_PATCHES = [
  "patch-learning-client.js",
  "patch-bot-page-mode-save.js",
  "patch-bot-page-support-mode.js",
  "patch-bot-clock-24h.js",
  "patch-ai-context-nav.js",
  "patch-ai-context-card-selection.js",
  "patch-meta-pages-messaging-scope.js",
  "patch-drive-v4-key-compat.js",
  "patch-drive-v4-api-key-folder-action.js",
  "patch-drive-folder-tree-hierarchy.js",
  "patch-catalog-key-rename.js",
  "patch-slide-generic-carousel.js",
  "patch-mapping-meta-midnight-delivery.js",
];

const RETIRED_PATCHES = [
  "patch-ai-context-center-validation.js",
  "patch-outbound-human-takeover.js",
  "patch-outbound-comment-private-reply.js",
  "patch-outbound-binary-image-upload.js",
  "patch-outbound-drive-image-proxy-v2.js",
  "patch-outbound-marketing-notifications.js",
  "patch-ai-brain-internal-auth.js",
  "patch-ai-dispatch-profile-gender-preflight.js",
];

test("only audited effective feature patches remain in startup", () => {
  for (const patch of ACTIVE_PATCHES) {
    assert.ok(fs.existsSync(patch), `${patch} must exist`);
    assert.match(start, new RegExp(patch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal(audit.summary.active_source_patches, ACTIVE_PATCHES.length);
  assert.equal(audit.summary.effective_source_patches, ACTIVE_PATCHES.length);
  assert.equal(audit.summary.no_source_effect, 0);
  assert.equal(audit.summary.failed, 0);
  assert.equal(audit.summary.missing, 0);
});

test("retired no-op and V8-only feature patches are deleted and cannot run", () => {
  for (const patch of RETIRED_PATCHES) {
    assert.equal(fs.existsSync(patch), false, `${patch} must be deleted`);
    assert.doesNotMatch(start, new RegExp(patch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal(audit.summary.retired_sources, RETIRED_PATCHES.length);
  assert.deepEqual(audit.retired.map((item) => item.patch).sort(), [...RETIRED_PATCHES].sort());
});

test("combined context seed is manual and matches the audited production source hash", () => {
  assert.ok(fs.existsSync("seed-tong-hop-context.js"));
  assert.doesNotMatch(start, /seed-tong-hop-context\.js/);
  const content = [
    fs.readFileSync("contexts/tong-hop.md", "utf8").trim(),
    fs.readFileSync("contexts/tong-hop-overrides.md", "utf8").trim(),
  ].join("\n\n");
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  assert.equal(hash, "fc1a85ddb315d2720a1b0be64b6d23dc362c596667cc33965cb8334e93f1b68f");
  assert.equal(audit.operational_seed.seed_hash, hash);
  assert.equal(audit.operational_seed.startup_imported, false);
  assert.equal(audit.operational_seed.classification, "manual_seed_current");
});
