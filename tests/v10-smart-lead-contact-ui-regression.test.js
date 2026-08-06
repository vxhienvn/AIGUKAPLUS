import test from "node:test";
import assert from "node:assert/strict";
import { enhanceSmartLeadUi } from "../dashboard-smart-lead-ui.js";

test("rendered Lead UI hides a separate Zalo column", () => {
  const html = enhanceSmartLeadUi("<body></body>");
  assert.match(html, /aiguka-merged-zalo-column/);
  assert.match(html, /SĐT\/Zalo/);
});
