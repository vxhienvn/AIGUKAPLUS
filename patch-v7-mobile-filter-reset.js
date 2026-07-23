import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_MOBILE_FILTER_RESET_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Mobile column-filter reset already installed");
} else {
  if (!source.includes("AIGUKA_LEAD_FILTER_STATUS_FIX_V2")) {
    throw new Error("MOBILE_FILTER_RESET_REQUIRES_STATUS_FIX_V2");
  }

  const filterRuntimeAnchor = "document.addEventListener('click',e=>{if(e.target.closest('.excel-filter-menu,.col-filter-btn'))return;closeMenu();";
  if (!source.includes(filterRuntimeAnchor)) {
    throw new Error("MOBILE_FILTER_RESET_RUNTIME_ANCHOR_NOT_FOUND");
  }

  const directReset = String.raw`// AIGUKA_MOBILE_FILTER_RESET_V1
function clearAllColumnFiltersDirect(){
  closeMenu();
  document.querySelectorAll('table.aiguka-data-table').forEach(table=>{
    const state=stateOf(table);
    if(state&&state.filters)state.filters.clear();
    applyFilters(table);
  });
}
window.aigukaClearAllColumnFilters=clearAllColumnFiltersDirect;
function resetColumnFiltersOnOpen(){
  clearAllColumnFiltersDirect();
  setTimeout(clearAllColumnFiltersDirect,120);
  setTimeout(clearAllColumnFiltersDirect,450);
}
window.addEventListener('pageshow',resetColumnFiltersOnOpen);
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',resetColumnFiltersOnOpen);else resetColumnFiltersOnOpen();
`;
  source = source.replace(filterRuntimeAnchor, directReset + filterRuntimeAnchor);

  const oldClear = String.raw`    async function clearActiveFilters(){
      const buttons=[...document.querySelectorAll('table.aiguka-data-table .col-filter-btn.active')];
      for(const button of buttons){
        button.click();
        await delay(20);
        const menu=document.querySelector('.excel-filter-menu');
        if(!menu)continue;
        const clear=[...menu.querySelectorAll('button')].find(item=>/bỏ lọc/i.test(String(item.textContent||'')));
        if(clear){clear.click();await delay(20)}
      }
      updateNotice();
    }`;
  const newClear = String.raw`    async function clearActiveFilters(){
      if(typeof window.aigukaClearAllColumnFilters==='function'){
        window.aigukaClearAllColumnFilters();
        updateNotice();
        return;
      }
      const buttons=[...document.querySelectorAll('table.aiguka-data-table .col-filter-btn.active')];
      for(const button of buttons){
        button.click();
        await delay(20);
        const menu=document.querySelector('.excel-filter-menu');
        if(!menu)continue;
        const clear=[...menu.querySelectorAll('button')].find(item=>/bỏ lọc/i.test(String(item.textContent||'')));
        if(clear){clear.click();await delay(20)}
      }
      updateNotice();
    }`;
  if (!source.includes(oldClear)) {
    throw new Error("MOBILE_FILTER_RESET_CLEAR_HANDLER_ANCHOR_NOT_FOUND");
  }
  source = source.replace(oldClear, newClear);

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`MOBILE_FILTER_RESET_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Column filters now clear directly from table state on mobile page restore");
}
