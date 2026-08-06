import test from "node:test";
import assert from "node:assert/strict";
import { enhanceSmartLeadUi } from "../dashboard-smart-lead-ui.js";

test("contact popup contains exactly two business states", () => {
  const html = enhanceSmartLeadUi("<body></body>");
  const popup = html.match(/<h4>Lọc: SĐT\/Zalo<\/h4>([\s\S]*?)<div class=\"aiguka-smart-contact-actions\">/);
  assert.ok(popup, "contact popup missing");
  const labels = [...popup[1].matchAll(/value=\"([^\"]+)\"/g)].map((match) => match[1]);
  assert.deepEqual(labels, ["Có SĐT/Zalo", "Không có SĐT/Zalo"]);
});
