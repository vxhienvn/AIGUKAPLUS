import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");

const counterCss = String.raw`
.lead-head-count{display:inline-flex;align-items:center;justify-content:center;min-width:27px;height:21px;margin-left:7px;padding:0 8px;border-radius:999px;color:#fff;font:700 11px Arial,sans-serif;vertical-align:middle;box-shadow:0 1px 2px #0002}
.lead-head-count.customers{background:#155eef}.lead-head-count.contacts{background:#067647}
`;
if (!source.includes(".lead-head-count{")) {
  source = source.replace("</style>", counterCss + "</style>");
}

const setupAnchor = "document.querySelectorAll('table').forEach(table=>{";
if (!source.includes(setupAnchor)) {
  throw new Error("V7_LEAD_COUNTER_SETUP_ANCHOR_NOT_FOUND");
}

const counterScript = String.raw`
function updateLeadHeaderCounts(table){
  const headers=[...(table.querySelectorAll('thead th')||[])];
  const customerIndex=headers.findIndex(th=>/^(khách hàng|tên khách hàng)$/i.test(clean(th.childNodes[0]?.textContent||th.textContent)));
  const contactIndex=headers.findIndex(th=>clean(th.childNodes[0]?.textContent||th.textContent).toLowerCase().replaceAll(' ','').includes('sđt/zalo'));
  if(customerIndex<0||contactIndex<0)return;
  const rows=[...(table.tBodies[0]?.rows||[])].filter(row=>row.style.display!=='none'&&row.cells.length>contactIndex);
  const contactCount=rows.filter(row=>contactCategory(row.cells[contactIndex].innerText)==='Có SĐT/Zalo').length;
  let customerBadge=headers[customerIndex].querySelector('.lead-head-count.customers');
  if(!customerBadge){
    customerBadge=document.createElement('span');
    customerBadge.className='lead-head-count customers';
    customerBadge.title='Số khách hàng đang hiển thị';
    headers[customerIndex].appendChild(customerBadge);
  }
  let contactBadge=headers[contactIndex].querySelector('.lead-head-count.contacts');
  if(!contactBadge){
    contactBadge=document.createElement('span');
    contactBadge.className='lead-head-count contacts';
    contactBadge.title='Số khách có SĐT/Zalo đang hiển thị';
    const filterButton=headers[contactIndex].querySelector('.col-filter-btn');
    filterButton?headers[contactIndex].insertBefore(contactBadge,filterButton):headers[contactIndex].appendChild(contactBadge);
  }
  customerBadge.textContent=String(rows.length);
  contactBadge.textContent=String(contactCount);
}
const applyFiltersWithoutCounters=applyFilters;
applyFilters=function(table){
  applyFiltersWithoutCounters(table);
  updateLeadHeaderCounts(table);
};
`;
source = source.replace(setupAnchor, counterScript + setupAnchor);

fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] Lead header counters added for customers and SĐT/Zalo");
