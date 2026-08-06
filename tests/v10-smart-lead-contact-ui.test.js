import test from "node:test";
import assert from "node:assert/strict";
import { enhanceSmartLeadUi, __private__ as smartPrivate } from "../dashboard-smart-lead-ui.js";
import { enhanceV10DashboardHtml } from "../dashboard-v10-admin-shell.js";
import { patchV10ReportTablesUi } from "../dashboard-report-v10-patch.js";
import { __private__ as reportDashboard } from "../dashboard-v10-stable.js";

test("smart lead UI injects one combined contact column contract", () => {
  const html = enhanceSmartLeadUi("<!doctype html><html><body><table></table></body></html>");
  assert.match(html, new RegExp(smartPrivate.SMART_LEAD_UI_MARKER));
  assert.match(html, /SĐT\/Zalo/);
  assert.match(html, /aiguka-merged-zalo-column/);
  assert.match(html, /Zalo:/);
  assert.doesNotMatch(html, /Tìm trong cột/);
});

test("contact filter exposes only practical yes/no states", () => {
  const html = enhanceSmartLeadUi("<body></body>");
  assert.match(html, /Có SĐT\/Zalo/);
  assert.match(html, /Không có SĐT\/Zalo/);
  assert.doesNotMatch(html, /data-value=.*0326/);
  assert.match(html, /contactSelection=new Set\(\['Có SĐT\/Zalo','Không có SĐT\/Zalo'\]\)/);
});

test("customer and contact totals are rendered beside table headers", () => {
  const html = enhanceSmartLeadUi("<body></body>");
  assert.match(html, /aiguka-head-count customer/);
  assert.match(html, /aiguka-head-count contact/);
  assert.match(html, /setBadge\(customerTh,'customer',visible\.length\)/);
  assert.match(html, /setBadge\(contactTh,'contact',contacts\)/);
});

test("smart UI is idempotent", () => {
  const once = enhanceSmartLeadUi("<body></body>");
  const twice = enhanceSmartLeadUi(once);
  assert.equal(twice, once);
  assert.equal((twice.match(/aiguka-smart-lead-ui-v2-script/g) || []).length, 1);
});

test("both report dashboards receive the same smart lead behavior", () => {
  const stable = enhanceV10DashboardHtml(reportDashboard.dashboardHtml());
  assert.match(stable, /aiguka-smart-lead-ui-v2-script/);
  const legacy = patchV10ReportTablesUi("<!doctype html><html><body></body></html>");
  assert.match(legacy, /aiguka-v10-report-table-script/);
  assert.match(legacy, /aiguka-smart-lead-ui-v2-script/);
});
