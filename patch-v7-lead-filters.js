import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");

source = source.replace(
  "const clean=v=>(String(v||'').replace(/s+/g,' ').trim()||'(Trống)');",
  "const clean=v=>(String(v||'').replace(/\\s+/g,' ').trim()||'(Trống)');",
);

const openStart = source.indexOf("function openFilter(table,th,col,button){");
const setupStart = source.indexOf("document.querySelectorAll('table').forEach(table=>{", openStart);
if (openStart < 0 || setupStart < 0) {
  throw new Error("V7_SMART_FILTER_ANCHOR_NOT_FOUND");
}

const smartOpenFilter = `function contactCategory(value){
  const text=clean(value);
  return text!==\"(Trống)\"&&(/\\d{8,}/.test(text)||/zalo/i.test(text))?\"Có SĐT/Zalo\":\"Không có\";
}
function openFilter(table,th,col,button){
  closeMenu();
  const state=stateOf(table);
  const header=clean(th.childNodes[0]?.textContent||th.textContent);
  const contactMode=/SĐT\\s*\\/\\s*Zalo/i.test(header);
  const rows=[...(table.tBodies[0]?.rows||[])].filter(r=>r.cells.length>col);
  const rawValues=rows.map(r=>clean(r.cells[col].innerText));
  const values=contactMode
    ? [\"Có SĐT/Zalo\",\"Không có\"]
    : [...new Set(rawValues)].sort((a,b)=>a.localeCompare(b,'vi',{numeric:true}));
  const currentActual=state.filters.get(col);
  const current=contactMode&&currentActual
    ? new Set(values.filter(category=>rawValues.some(value=>contactCategory(value)===category&&currentActual.has(value))))
    : currentActual;
  const menu=document.createElement('div');
  menu.className='excel-filter-menu';
  openMenu=menu;
  const title=document.createElement('div');
  title.className='excel-filter-title';
  title.textContent='Lọc: '+header;
  menu.appendChild(title);
  const search=document.createElement('input');
  search.type='search';
  search.placeholder='Tìm trong cột...';
  if(contactMode) search.style.display='none';
  menu.appendChild(search);
  const list=document.createElement('div');
  list.className='excel-filter-values';
  menu.appendChild(list);
  const boxes=[];
  values.forEach(value=>{
    const label=document.createElement('label');
    const box=document.createElement('input');
    box.type='checkbox';
    box.checked=!current||current.has(value);
    box.dataset.value=value;
    const text=document.createElement('span');
    text.textContent=value;
    label.append(box,text);
    list.appendChild(label);
    boxes.push({box,label,value});
  });
  const count=document.createElement('div');
  count.className='excel-filter-count';
  count.textContent=contactMode?'Chọn theo trạng thái liên hệ':values.length+' giá trị';
  menu.appendChild(count);
  const actions=document.createElement('div');
  actions.className='excel-filter-actions';
  const all=document.createElement('button');
  all.type='button';
  all.textContent='Chọn tất cả';
  const clear=document.createElement('button');
  clear.type='button';
  clear.textContent='Bỏ lọc';
  const apply=document.createElement('button');
  apply.type='button';
  apply.className='primary';
  apply.textContent='Áp dụng';
  actions.append(all,clear,apply);
  menu.appendChild(actions);
  document.body.appendChild(menu);
  const rect=button.getBoundingClientRect();
  const maxLeft=window.innerWidth-menu.offsetWidth-10;
  menu.style.left=Math.max(10,Math.min(rect.left,maxLeft))+'px';
  menu.style.top=Math.min(rect.bottom+5,window.innerHeight-menu.offsetHeight-10)+'px';
  search.addEventListener('input',()=>{
    const q=clean(search.value).toLowerCase();
    boxes.forEach(item=>item.label.style.display=item.value.toLowerCase().includes(q)?'':'none');
  });
  all.onclick=()=>boxes.forEach(item=>{if(item.label.style.display!=='none')item.box.checked=true});
  clear.onclick=()=>{state.filters.delete(col);applyFilters(table);closeMenu()};
  apply.onclick=()=>{
    const chosen=new Set(boxes.filter(item=>item.box.checked).map(item=>item.value));
    if(chosen.size===values.length){
      state.filters.delete(col);
    }else if(contactMode){
      state.filters.set(col,new Set(rawValues.filter(value=>chosen.has(contactCategory(value)))));
    }else{
      state.filters.set(col,chosen);
    }
    applyFilters(table);
    closeMenu();
  };
  menu.addEventListener('click',e=>e.stopPropagation());
  if(!contactMode) search.focus();
}
`;

source = source.slice(0, openStart) + smartOpenFilter + source.slice(setupStart);

const oldSetup = "document.querySelectorAll('table').forEach(table=>{table.querySelectorAll('thead th').forEach((th,col)=>{const button=document.createElement('button');button.type='button';button.className='col-filter-btn';button.title='Lọc cột như Excel';button.textContent='▾';button.onclick=e=>{e.stopPropagation();openFilter(table,th,col,button)};th.appendChild(button)});applyFilters(table)});";
const newSetup = "document.querySelectorAll('table').forEach(table=>{table.querySelectorAll('thead th').forEach((th,col)=>{const header=clean(th.textContent);if(header==='#'||/^Khách hàng$/i.test(header)||/^Tên khách hàng$/i.test(header))return;const button=document.createElement('button');button.type='button';button.className='col-filter-btn';button.title='Lọc cột';button.textContent='▾';button.onclick=e=>{e.stopPropagation();openFilter(table,th,col,button)};th.appendChild(button)});applyFilters(table)});";
if (!source.includes(oldSetup)) {
  throw new Error("V7_FILTER_SETUP_ANCHOR_NOT_FOUND");
}
source = source.replace(oldSetup, newSetup);

fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] Lead filters simplified: no STT/name filter; SĐT/Zalo uses yes/no filter");