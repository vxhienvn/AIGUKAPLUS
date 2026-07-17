import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_LEAD_LOGICAL_FILTER_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Lead logical filters already installed");
} else {
  const rowNeedle = `return '<tr class="lead-ad-row" data-customer="'+esc(group.name)+'" data-account="'+esc(x.accountName||'')+'" data-ad="'+esc(x.adName||'')+'" data-product="'+esc(x.product||'')+'">'`;
  const rowReplacement = `return '<tr class="lead-ad-row" data-customer="'+esc(group.name)+'" data-contact="'+esc(contact)+'" data-account="'+esc(x.accountName||'')+'" data-campaign="'+esc(x.campaignName||'')+'" data-adset="'+esc(x.adsetName||'')+'" data-ad="'+esc(x.adName||'')+'" data-product="'+esc(x.product||'')+'" data-source="'+esc(x.source_type||'Meta Business')+'" data-tags="'+esc((x.tags||[]).join(', '))+'">'`;
  if (!source.includes(rowNeedle)) throw new Error("LEAD_LOGICAL_ROW_ANCHOR_NOT_FOUND");
  source = source.replace(rowNeedle, rowReplacement);

  const cellStart = source.indexOf("function value(v)");
  const stateStart = source.indexOf("function state(table)", cellStart);
  if (cellStart < 0 || stateStart < 0) throw new Error("LEAD_LOGICAL_CELLVALUE_ANCHOR_NOT_FOUND");
  const oldCellBlock = source.slice(cellStart, stateStart);
  const valueFunctionEnd = oldCellBlock.indexOf("function cellValue");
  if (valueFunctionEnd < 0) throw new Error("LEAD_LOGICAL_VALUE_FUNCTION_NOT_FOUND");
  const valuePrefix = oldCellBlock.slice(0, valueFunctionEnd);
  const newCellBlock = valuePrefix + `function cellValue(table,row,col,heading){
    if(row.classList.contains("daily-account-row")){
      if(heading==="ngày")return value(row.dataset.date);
      if(heading==="tài khoản qc"||heading==="tài khoản")return value(row.dataset.account||row.querySelector(".account-name-cell")?.innerText);
      if(heading==="thẻ / phương thức")return value(row.querySelector(".payment-method-cell")?.innerText);
      if(heading==="nhân viên"){const names=[...row.querySelectorAll("[data-staff-name]")].map(x=>x.dataset.staffName).filter(Boolean);return value(names.join(", ")||row.querySelector(".staff-content")?.innerText)}
    }
    if(row.classList.contains("lead-ad-row")){
      if(heading==="khách hàng")return value(row.dataset.customer);
      if(heading==="sđt/zalo"||heading==="sđt / zalo")return value(row.dataset.contact);
      if(heading==="tài khoản qc"||heading==="tài khoản")return value(row.dataset.account);
      if(heading==="campaign"||heading==="chiến dịch")return value(row.dataset.campaign);
      if(heading==="ad set"||heading==="nhóm quảng cáo")return value(row.dataset.adset);
      if(heading==="campaign / ad set"||heading==="chiến dịch / nhóm quảng cáo")return value([row.dataset.campaign,row.dataset.adset].filter(Boolean).join(" / "));
      if(heading==="quảng cáo")return value(row.dataset.ad);
      if(heading==="sản phẩm")return value(row.dataset.product);
      if(heading==="nguồn khách")return value(row.dataset.source);
      if(heading==="tag pancake")return value(row.dataset.tags);
    }
    return value(row.cells[col]?.innerText)
  }
  `;
  source = source.slice(0, cellStart) + newCellBlock + source.slice(stateStart);

  const applyStart = source.indexOf("function apply(table){");
  const openStart = source.indexOf("function open(table,th,col,button){", applyStart);
  if (applyStart < 0 || openStart < 0) throw new Error("LEAD_LOGICAL_APPLY_ANCHOR_NOT_FOUND");
  const newApply = `function apply(table){
    const filters=state(table),headers=[...table.querySelectorAll("thead th")];
    const rows=[...(table.tBodies[0]?.rows||[])];
    const matches=row=>{for(const [col,set]of filters){if(!set.has(cellValue(table,row,col,title(headers[col]))))return false}return true};
    if(table.classList.contains("lead-report-table")){
      const groups=new Map();
      rows.forEach(row=>{const key=row.dataset.customer||String(rows.indexOf(row));if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)});
      groups.forEach(group=>{const show=group.some(matches);group.forEach(row=>row.style.display=show?"":"none")});
    }else rows.forEach(row=>row.style.display=matches(row)?"":"none");
    headers.forEach((th,i)=>th.querySelector(".col-filter-btn")?.classList.toggle("active",filters.has(i)));
    sync(table)
  }
  `;
  source = source.slice(0, applyStart) + newApply + source.slice(openStart);

  const openNeedle = 'const filters=state(table),values=[...new Set([...(table.tBodies[0]?.rows||[])].filter(r=>r.cells[col]).map(r=>cellValue(table,r,col,title(th))))]';
  if (!source.includes(openNeedle)) throw new Error("LEAD_LOGICAL_OPEN_FILTER_ANCHOR_NOT_FOUND");
  source = source.replace(openNeedle, 'const filters=state(table),values=[...new Set([...(table.tBodies[0]?.rows||[])].map(r=>cellValue(table,r,col,title(th))))]');

  const contactNeedle = "const contactCount=rows.filter(row=>contactCategory(row.cells[contactIndex].innerText)==='Có SĐT/Zalo').length;";
  if (source.includes(contactNeedle)) {
    source = source.replace(contactNeedle, "const customerKeys=new Set(rows.map(row=>row.dataset.customer||row.cells[customerIndex]?.innerText).filter(Boolean));const contactKeys=new Set(rows.filter(row=>contactCategory(row.dataset.contact||row.cells[contactIndex]?.innerText)==='Có SĐT/Zalo').map(row=>row.dataset.customer||row.cells[customerIndex]?.innerText).filter(Boolean));const contactCount=contactKeys.size;");
    source = source.replace("customerBadge.textContent='Khách '+String(rows.length);", "customerBadge.textContent='Khách '+String(customerKeys.size);");
  }

  source = source.replace("</body>", "<!-- AIGUKA_LEAD_LOGICAL_FILTER_V1 --></body>");
  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`LEAD_LOGICAL_FILTER_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Lead filters now use logical customer and ad fields");
}
