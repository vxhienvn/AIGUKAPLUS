import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_LEAD_CONTACT_UI_V2";

if (source.includes(marker)) {
  console.log("[AIGUKA] Lead contact UI V2 already installed");
} else {
  const rawContact = 'if(heading==="sđt/zalo"||heading==="sđt / zalo")return value(row.dataset.contact);';
  const categoryContact = 'if(heading==="sđt/zalo"||heading==="sđt / zalo"){const contact=value(row.dataset.contact);return contact!=="(Trống)"&&(/[0-9]{8,}/.test(contact)||/zalo/i.test(contact))?"Có SĐT/Zalo":"Không có";}';
  if (!source.includes(rawContact)) throw new Error("LEAD_CONTACT_CATEGORY_ANCHOR_NOT_FOUND");
  source = source.replace(rawContact, categoryContact);

  const rowToken = `data-customer="'+esc(group.name)+'" data-contact=`;
  const rowKeyToken = `data-customer="'+esc(group.name)+'" data-customer-key="'+esc(String(x.sender_id||x.customer_id||group.name))+'" data-contact=`;
  if (!source.includes(rowToken)) throw new Error("LEAD_CONTACT_CUSTOMER_KEY_ANCHOR_NOT_FOUND");
  source = source.replace(rowToken, rowKeyToken);

  source = source.replace(
    'const key=row.dataset.customer||String(rows.indexOf(row));',
    'const key=row.dataset.customerKey||row.dataset.customer||String(rows.indexOf(row));',
  );
  source = source.replaceAll(
    'row.dataset.customer||row.cells[customerIndex]?.innerText',
    'row.dataset.customerKey||row.dataset.customer||row.cells[customerIndex]?.innerText',
  );

  const css = String.raw`
/* AIGUKA_LEAD_CONTACT_UI_V2 */
.lead-head-count{display:inline-flex;align-items:center;justify-content:center;height:21px;margin-left:6px;padding:0 8px;border-radius:999px;color:#fff;font:700 11px Arial,sans-serif;vertical-align:middle;white-space:nowrap;box-shadow:0 1px 2px #0002}
.lead-head-count.customers{background:#475467}.lead-head-count.contacts{background:#067647}
.excel-filter-menu.aiguka-contact-filter input[type="search"]{display:none!important}
.excel-filter-menu.aiguka-contact-filter .excel-filter-values{max-height:110px!important}
`;
  const styleEnd = source.indexOf("</style>");
  if (styleEnd < 0) throw new Error("LEAD_CONTACT_STYLE_ANCHOR_NOT_FOUND");
  source = source.slice(0, styleEnd) + css + source.slice(styleEnd);

  const script = String.raw`<script id="aiguka-lead-contact-ui-v2">(function(){
    const norm=v=>String(v||'').replace(/\s+/g,' ').trim().toLowerCase();
    const contactState=v=>{const text=String(v||'').trim();return text&&(/[0-9]{8,}/.test(text)||/zalo/i.test(text))?'Có SĐT/Zalo':'Không có'};
    let queued=false;
    function ensureBadge(th,type,title){
      let badge=th.querySelector('.lead-head-count.'+type);
      if(!badge){badge=document.createElement('span');badge.className='lead-head-count '+type;badge.title=title;const filter=th.querySelector('.col-filter-btn');filter?th.insertBefore(badge,filter):th.appendChild(badge)}
      return badge;
    }
    function updateTable(table){
      if(!table||!table.classList.contains('lead-report-table'))return;
      const headers=[...table.querySelectorAll('thead th')];
      const customerHeader=headers.find(th=>norm(th.cloneNode(true).textContent).startsWith('khách hàng'));
      const contactHeader=headers.find(th=>{const t=norm(th.cloneNode(true).textContent).replaceAll(' ','');return t.startsWith('sđt/zalo')});
      if(!customerHeader||!contactHeader)return;
      const rows=[...(table.tBodies[0]?.querySelectorAll('tr.lead-ad-row')||[])].filter(row=>row.style.display!=='none');
      const customers=new Set();
      const contacts=new Set();
      for(const row of rows){
        const key=row.dataset.customerKey||row.dataset.customer||'';
        if(!key)continue;
        customers.add(key);
        if(contactState(row.dataset.contact)==='Có SĐT/Zalo')contacts.add(key);
      }
      ensureBadge(customerHeader,'customers','Số khách hàng đang hiển thị').textContent='Khách '+customers.size;
      ensureBadge(contactHeader,'contacts','Số khách có SĐT hoặc Zalo đang hiển thị').textContent='Có '+contacts.size;
    }
    function simplifyMenu(menu){
      if(!menu||menu.dataset.aigukaContactDone==='1')return;
      const heading=norm(menu.querySelector('b,.excel-filter-title')?.textContent).replaceAll(' ','');
      if(!heading.includes('sđt/zalo'))return;
      menu.dataset.aigukaContactDone='1';
      menu.classList.add('aiguka-contact-filter');
      const count=menu.querySelector('.excel-filter-count');if(count)count.textContent='2 trạng thái';
      const search=menu.querySelector('input[type="search"]');if(search)search.value='';
    }
    function update(){queued=false;document.querySelectorAll('table.lead-report-table').forEach(updateTable);document.querySelectorAll('.excel-filter-menu').forEach(simplifyMenu)}
    function schedule(){if(queued)return;queued=true;requestAnimationFrame(update)}
    new MutationObserver(mutations=>{for(const m of mutations){if(m.type==='childList'||m.attributeName==='style'||m.attributeName==='class'){schedule();break}}}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class']});
    document.addEventListener('click',()=>setTimeout(schedule,0),true);
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule);else schedule();
  })();</script>`;
  if (!source.includes("</body>")) throw new Error("LEAD_CONTACT_BODY_ANCHOR_NOT_FOUND");
  source = source.replace("</body>", script + `<!-- ${marker} --></body>`);

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`LEAD_CONTACT_UI_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Lead counters restored and contact filter reduced to two states");
}
