import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("smart Lead UI source keeps combined contact behavior", () => {
  const source = fs.readFileSync("dashboard-smart-lead-ui.js", "utf8");
  assert.match(source, /SĐT\/Zalo/);
  assert.match(source, /Không có SĐT\/Zalo/);
  assert.match(source, /aiguka-head-count customer/);
  assert.match(source, /aiguka-head-count contact/);
  assert.match(source, /aiguka-merged-zalo-column/);
});
