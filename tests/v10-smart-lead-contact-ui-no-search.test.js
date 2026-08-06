import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("contact filter does not render a distinct phone search field", () => {
  const source = fs.readFileSync("dashboard-smart-lead-ui.js", "utf8");
  assert.doesNotMatch(source, /Tìm trong cột/);
});
