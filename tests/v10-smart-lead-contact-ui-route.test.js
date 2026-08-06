import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("smart Lead UI is wired into both dashboard paths", () => {
  const adminShell = fs.readFileSync("dashboard-v10-admin-shell.js", "utf8");
  const compatibilityPatch = fs.readFileSync("dashboard-report-v10-patch.js", "utf8");
  assert.match(adminShell, /enhanceSmartLeadUi/);
  assert.match(compatibilityPatch, /enhanceSmartLeadUi/);
});
