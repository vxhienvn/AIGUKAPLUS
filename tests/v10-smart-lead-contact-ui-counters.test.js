import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("header counters use visible rows and visible contacts", () => {
  const source = fs.readFileSync("dashboard-smart-lead-ui.js", "utf8");
  assert.match(source, /visible\.length/);
  assert.match(source, /contacts=visible\.filter/);
  assert.match(source, /setBadge\(customerTh,'customer',visible\.length\)/);
  assert.match(source, /setBadge\(contactTh,'contact',contacts\)/);
});
