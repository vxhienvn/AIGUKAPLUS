import fs from "node:fs";
const file="v7-dashboard-stable.js";
let source=fs.readFileSync(file,"utf8");

source=source.replaceAll("fields=id,name,account_status&limit=", "fields=id,name,account_status,timezone_name,timezone_offset_hours_utc&limit=");
source=source.replace(
  'map.set(id, { ...old, id, name: old.name && old.name !== id ? old.name : (x.name || x.account_name || id), status: x.account_status || x.status || old.status || "", source: old.source ? `${old.source}+${source}` : source });',
  'map.set(id, { ...old, id, name: old.name && old.name !== id ? old.name : (x.name || x.account_name || id), status: x.account_status || x.status || old.status || "", timezoneName: x.timezone_name || old.timezoneName || "Không xác định", timezoneOffset: x.timezone_offset_hours_utc ?? old.timezoneOffset ?? null, source: old.source ? `${old.source}+${source}` : source });'
);

const loopStart='for (const account of accounts) {\n    try {';
const loopCount=source.split(loopStart).length-1;
if(loopCount<2) throw new Error("V7_ACCOUNT_LOOPS_NOT_FOUND:"+loopCount);
source=source.replaceAll(loopStart,'await Promise.all(accounts.map(async account => {\n    try {');
const loopEnd='    } catch (e) { result.errors.push(`${account.name}: ${e.message}`); }\n  }\n  result.rows.sort';
const endCount=source.split(loopEnd).length-1;
if(endCount<2) throw new Error("V7_ACCOUNT_LOOP_ENDS_NOT_FOUND:"+endCount);
source=source.replaceAll(loopEnd,'    } catch (e) { result.errors.push(`${account.name}: ${e.message}`); }\n  }));\n  result.rows.sort');

source=source.replace(
  '<div class="card table"><table><thead><tr><th>#</th><th>Khách hàng</th>',
  '<div class="card table"><table data-meta-messages="${meta.totalMessages}" data-customer-count="${leads.length}"><thead><tr><th>#</th><th>Khách hàng</th>'
);
source=source.replaceAll(
  '<td>${esc(x.product)}</td><td class="tags">',
  '<td>${esc(x.product)}</td><td>${esc(x.source_type||"Tin nhắn")}</td><td class="tags">'
);
source=source.replace(
  '<th>Quảng cáo</th><th>Sản phẩm</th><th>Tag Pancake</th>',
  '<th>Quảng cáo</th><th>Sản phẩm</th><th>Nguồn khách</th><th>Tag Pancake</th>'
);
source=source.replace('colspan="10">Không có khách phù hợp.', 'colspan="11">Không có khách phù hợp.');

fs.writeFileSync(file,source,"utf8");
console.log("[AIGUKA] Meta reports concurrent; each account uses its own Meta timezone; message and customer counters separated");
