import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_LEAD_FILTER_STATUS_FIX_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Lead filter and ad status fix already installed");
} else {
  if (!source.includes("AIGUKA_SPLIT_LEADS_AD_PERFORMANCE_V1")) {
    throw new Error("LEAD_FILTER_STATUS_REQUIRES_SPLIT_PAGES");
  }

  const helperAnchor = "async function hydrateLeadEntityStatuses(leads) {";
  if (!source.includes(helperAnchor)) {
    throw new Error("LEAD_FILTER_STATUS_HELPER_ANCHOR_NOT_FOUND");
  }

  const helpers = String.raw`// AIGUKA_LEAD_FILTER_STATUS_FIX_V1
function entityStatusDot(value) {
  const status=normalizedEntityStatus(value);
  const kind=status.kind||'unknown';
  const label=status.label||'Chưa đọc được trạng thái';
  return '<span class="entity-dot '+kind+'" title="'+esc(label)+'" aria-label="'+esc(label)+'"></span>';
}

function entityDotNameCell(name,status,id) {
  const title=String(name||'').trim();
  const identifier=String(id||'').trim();
  if(!title&&!identifier)return '';
  return entityStatusDot(status)+(title?'<b>'+esc(title)+'</b>':'')+(identifier?'<br><small>ID '+esc(identifier)+'</small>':'');
}

`;
  source = source.replace(helperAnchor, helpers + helperAnchor);

  const performanceAnchor = "  const performance=buildMetaAdPerformance(report);";
  const hydratedPerformance = "  const performance=buildMetaAdPerformance(report);\n  performance.rows=await hydrateLeadEntityStatuses(performance.rows||[]);";
  if (!source.includes(performanceAnchor)) {
    throw new Error("LEAD_FILTER_STATUS_PERFORMANCE_ANCHOR_NOT_FOUND");
  }
  source = source.replace(performanceAnchor, hydratedPerformance);

  const campaignCell = "+'<td>'+esc(x.campaignName||'')+'</td>'";
  const adsetCell = "+'<td>'+esc(x.adsetName||'')+'</td>'";
  const adCell = "+'<td><b>'+esc(x.adName||'')+'</b><br><small>ID '+esc(x.adId||'')+'</small></td>'";
  if (!source.includes(campaignCell) || !source.includes(adsetCell) || !source.includes(adCell)) {
    throw new Error("LEAD_FILTER_STATUS_CELL_ANCHOR_NOT_FOUND");
  }
  source = source.replace(campaignCell, "+'<td>'+entityDotNameCell(x.campaignName,x.campaignStatus,x.campaignId)+'</td>'");
  source = source.replace(adsetCell, "+'<td>'+entityDotNameCell(x.adsetName,x.adsetStatus,x.adsetId)+'</td>'");
  source = source.replace(adCell, "+'<td>'+entityDotNameCell(x.adName,x.adStatus,x.adId||x.ad_id)+'</td>'");

  const css = ".entity-dot{display:inline-block;width:9px;height:9px;margin:0 7px 1px 0;border-radius:50%;vertical-align:middle;background:#94a3b8;box-shadow:0 0 0 2px #fff,0 0 0 3px #cbd5e1}.entity-dot.on{background:#16a34a;box-shadow:0 0 0 2px #fff,0 0 0 3px #86efac}.entity-dot.off{background:#94a3b8}.entity-dot.pending{background:#f59e0b;box-shadow:0 0 0 2px #fff,0 0 0 3px #fcd34d}.entity-dot.bad{background:#dc2626;box-shadow:0 0 0 2px #fff,0 0 0 3px #fca5a5}.entity-dot.unknown{background:#94a3b8}.aiguka-clear-filters{margin-left:8px;padding:8px 11px!important;border:1px solid #94a3b8!important;background:#fff!important;color:#334155!important;font-weight:700}.aiguka-filter-warning{display:none;margin:0 0 10px;padding:8px 10px;border:1px solid #f59e0b;border-radius:8px;background:#fffbeb;color:#92400e;font-size:12px}.aiguka-filter-warning.show{display:block}";
  if (!source.includes("#tap{")) throw new Error("LEAD_FILTER_STATUS_CSS_ANCHOR_NOT_FOUND");
  source = source.replace("#tap{", css + "#tap{");

  const script = String.raw`<script id="aiguka-lead-filter-status-fix">(function(){
    const allowed=/^\/(leads|customers|ad-performance|ad-report)\/?$/i.test(location.pathname);
    if(!allowed)return;
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    async function clearActiveFilters(){
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
    }
    function activeCount(){return document.querySelectorAll('table.aiguka-data-table .col-filter-btn.active').length}
    function updateNotice(){
      const notice=document.getElementById('aiguka-filter-warning');
      if(!notice)return;
      const count=activeCount();
      notice.classList.toggle('show',count>0);
      notice.querySelector('span').textContent=count?('Đang có '+count+' bộ lọc cột làm ẩn bớt dữ liệu.'):'Không có bộ lọc cột.';
    }
    function installControls(){
      const firstTable=document.querySelector('table.aiguka-data-table');
      if(!firstTable||document.getElementById('aiguka-filter-warning'))return;
      const card=firstTable.closest('.card')||firstTable.parentElement;
      const notice=document.createElement('div');
      notice.id='aiguka-filter-warning';
      notice.className='aiguka-filter-warning';
      notice.innerHTML='<span></span><button type="button" class="aiguka-clear-filters">Hiển thị tất cả</button>';
      notice.querySelector('button').addEventListener('click',clearActiveFilters);
      card.insertBefore(notice,card.firstChild);
      updateNotice();
    }
    async function resetOnOpen(){
      installControls();
      await delay(80);
      await clearActiveFilters();
    }
    window.addEventListener('pageshow',resetOnOpen);
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',resetOnOpen);else resetOnOpen();
    document.addEventListener('click',()=>setTimeout(updateNotice,40),true);
  })();</script>`;
  if (!source.includes("</body>")) throw new Error("LEAD_FILTER_STATUS_BODY_ANCHOR_NOT_FOUND");
  source = source.replace("</body>", script + "</body>");

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`LEAD_FILTER_STATUS_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Lead filters reset on open and Meta entity status dots enabled");
}
