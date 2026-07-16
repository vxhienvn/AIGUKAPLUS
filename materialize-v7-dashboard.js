import fs from "node:fs";
import crypto from "node:crypto";

const supabaseUrl = String(
  process.env.SUPABASE_URL || "https://ezygfpeeqbbirdeazene.supabase.co",
).replace(/\/$/, "");
const publishableKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "";

if (!publishableKey) {
  throw new Error("MISSING_SUPABASE_PUBLISHABLE_KEY");
}

const response = await fetch(
  `${supabaseUrl}/rest/v1/rpc/v8_get_embedded_code_test`,
  {
    method: "POST",
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${publishableKey}`,
      "content-type": "application/json",
      "x-aiguka-railway-test": "enabled",
      "x-aiguka-admin-secret": "AIGUKA_RAILWAY_TEST_MODE",
    },
    body: JSON.stringify({ p_code_key: "v7_dashboard_stable" }),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  },
);

const payload = await response.json().catch(() => ({}));
if (!response.ok || !payload?.ok || !Array.isArray(payload?.chunks)) {
  throw new Error(
    payload?.message || payload?.error || `V7_CODE_HTTP_${response.status}`,
  );
}

const sourceBuffer = Buffer.from(payload.chunks.join(""), "base64");
const md5 = crypto.createHash("md5").update(sourceBuffer).digest("hex");
const expectedBytes = 23_115;
const expectedMd5 = "971b141fedd159796a7d57a1467aaf69";

if (sourceBuffer.length !== expectedBytes || md5 !== expectedMd5) {
  throw new Error(
    `V7_CODE_INTEGRITY_ERROR bytes=${sourceBuffer.length} md5=${md5}`,
  );
}

let source = sourceBuffer.toString("utf8");

function replaceRequired(needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`V7_PATCH_ANCHOR_NOT_FOUND:${label}`);
  source = source.replace(needle, replacement);
}

const tokenDeclaration = 'const META_TOKEN = process.env.META_ACCESS_TOKEN || process.env.META_USER_ACCESS_TOKEN || process.env.FACEBOOK_USER_ACCESS_TOKEN || process.env.USER_ACCESS_TOKEN || "";';
replaceRequired(
  tokenDeclaration,
  'const getMetaToken = () => process.env.META_ACCESS_TOKEN || process.env.META_USER_ACCESS_TOKEN || process.env.FACEBOOK_USER_ACCESS_TOKEN || process.env.USER_ACCESS_TOKEN || "";',
  "meta_token",
);
source = source.replaceAll("META_TOKEN", "getMetaToken()");

source = source.replaceAll(
  'selected = act(req.query.account) || "all"',
  'selected = String(req.query.account || "all") === "all" ? "all" : act(req.query.account)',
);
source = source.replaceAll(
  "selected=act(req.query.account)||'all'",
  "selected=String(req.query.account||'all')==='all'?'all':act(req.query.account)",
);
source = source.replaceAll("account=act_all", "account=all");

const billingHelpers = String.raw`
function extractCardLast4(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  const patterns = [
    /(?:Visa|Mastercard|MasterCard|card|thẻ|the)\D{0,30}(?:\*{2,}|x{2,}|…|\.{2,}|-)?\s*(\d{4})/i,
    /(?:last4|last_4|last_four|card_last4)\D{0,20}(\d{4})/i,
    /(?:\*{2,}|x{2,}|…|\.{2,})\s*(\d{4})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function accountCardMap() {
  const map = new Map();
  const raw = String(process.env.META_ACCOUNT_CARD_MAP || "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      for (const [id, value] of Object.entries(parsed || {})) {
        const last4 = typeof value === "object" ? (value.card || value.last4 || "") : value;
        if (last4) map.set(act(id), String(last4).slice(-4));
      }
    } catch {
      for (const item of raw.split(/[;,\n]+/)) {
        const parts = item.split(/[=:]/).map(x => String(x || "").trim());
        if (parts[0] && parts[1]) map.set(act(parts[0]), parts[1].slice(-4));
      }
    }
  }
  if (process.env.META_CARD_LAST4 && process.env.META_AD_ACCOUNT_ID) {
    map.set(act(process.env.META_AD_ACCOUNT_ID), String(process.env.META_CARD_LAST4).slice(-4));
  }
  return map;
}

function paymentMethodLabel(account = {}) {
  const last4 = String(account.cardLast4 || "").slice(-4);
  if (last4) return "Thẻ •••• " + last4;
  return account.fundingSourceReadable || account.paymentMethod || "Trả trước / chưa đọc được thẻ";
}

async function hydrateBilling(accounts = []) {
  const manual = accountCardMap();
  const token = getMetaToken();
  const fetchEnabled = String(process.env.META_FETCH_BILLING_DETAILS || "true").toLowerCase() !== "false";
  return Promise.all((accounts || []).map(async account => {
    const id = act(account.id || account.accountId || "");
    const manualLast4 = manual.get(id) || String(account.cardLast4 || "").slice(-4);
    if (manualLast4) return { ...account, cardLast4: manualLast4, paymentMethod: "Thẻ •••• " + manualLast4 };
    if (!fetchEnabled || !token || !id) return { ...account, cardLast4: "", paymentMethod: paymentMethodLabel(account) };
    try {
      const fields = "id,name,account_id,funding_source,funding_source_details";
      const details = await fetchJson("https://graph.facebook.com/" + GRAPH_VERSION + "/" + id + "?fields=" + fields + "&access_token=" + encodeURIComponent(token));
      const last4 = extractCardLast4(details.funding_source_details || details.funding_source || details);
      return {
        ...account,
        name: account.name && account.name !== id ? account.name : (details.name || account.name || id),
        cardLast4: last4,
        paymentMethod: last4 ? "Thẻ •••• " + last4 : paymentMethodLabel(account),
        billingRead: true,
      };
    } catch (error) {
      return { ...account, cardLast4: "", paymentMethod: paymentMethodLabel(account), billingRead: false, billingError: error.message };
    }
  }));
}
`;
replaceRequired("function parseIds(raw) {", billingHelpers + "\nfunction parseIds(raw) {", "billing_helpers");

replaceRequired(
  'const data = [...map.values()].sort((a,b) => a.name.localeCompare(b.name, "vi"));',
  'const data = await hydrateBilling([...map.values()]); data.sort((a,b) => a.name.localeCompare(b.name, "vi"));',
  "hydrate_accounts",
);

source = source.replace(
  'result.rows.push({ accountId: account.id, accountName: account.name, adId:',
  'result.rows.push({ accountId: account.id, accountName: account.name, cardLast4: account.cardLast4 || "", paymentMethod: paymentMethodLabel(account), adId:',
);
source = source.replace(
  'result.rows.push({ date: x.date_start || "", accountId: account.id, accountName: account.name, spend, messages });',
  'result.rows.push({ date: x.date_start || "", accountId: account.id, accountName: account.name, cardLast4: account.cardLast4 || "", paymentMethod: paymentMethodLabel(account), spend, messages });',
);

source = source.replace(
  "<td>${esc(x.accountName)}</td><td>${esc(x.campaignName)}<br><small>${esc(x.adsetName)}</small></td>",
  "<td>${esc(x.accountName)}</td><td>${esc(x.paymentMethod || (x.cardLast4 ? 'Thẻ •••• '+x.cardLast4 : ''))}</td><td>${esc(x.campaignName)}<br><small>${esc(x.adsetName)}</small></td>",
);
source = source.replace(
  "<th>#</th><th>Quảng cáo</th><th>Tài khoản</th><th>Campaign / Ad set</th><th>Chi tiêu</th><th>Tin nhắn Meta</th><th>Hội thoại Pancake</th><th>Liên hệ</th><th>Tỷ lệ</th>",
  "<th>#</th><th>Quảng cáo</th><th>Tài khoản</th><th>Thẻ / Phương thức</th><th>Campaign / Ad set</th><th>Chi tiêu</th><th>Tin nhắn Meta</th><th>Hội thoại Pancake</th><th>Liên hệ</th><th>Tỷ lệ</th>",
);
source = source.replace('colspan="9">Không có dữ liệu phù hợp.', 'colspan="10">Không có dữ liệu phù hợp.');

replaceRequired(
  "const rows=data.rows.map((x,i)=>`<tr><td>${i+1}</td><td>${x.date}</td><td>${esc(x.accountName)}</td><td>${money(x.spend)}</td><td>${x.messages}</td></tr>`).join('');",
  "const rows=data.rows.map((x,i)=>`<tr><td>${i+1}</td><td>${x.date}</td><td>${esc(x.accountName)}</td><td>${esc(x.paymentMethod || (x.cardLast4 ? 'Thẻ •••• '+x.cardLast4 : 'Trả trước / chưa đọc được thẻ'))}</td><td>${money(x.spend)}</td><td>${x.messages}</td></tr>`).join('');",
  "daily_rows",
);
source = source.replace(
  "<th>#</th><th>Ngày</th><th>Tài khoản QC</th><th>Chi tiêu</th><th>Tin nhắn</th>",
  "<th>#</th><th>Ngày</th><th>Tài khoản QC</th><th>Thẻ / Phương thức</th><th>Chi tiêu</th><th>Tin nhắn</th>",
);
source = source.replace('colspan="5">Không có dữ liệu.', 'colspan="6">Không có dữ liệu.');

source = source.replace(
  "rows=d.rows.map(x=>[x.date,x.accountName,x.accountId,x.spend,x.messages]);",
  "rows=d.rows.map(x=>[x.date,x.accountName,x.accountId,x.paymentMethod || (x.cardLast4 ? 'Thẻ •••• '+x.cardLast4 : ''),x.spend,x.messages]);",
);
source = source.replace(
  "['Ngày','Tài khoản QC','ID tài khoản','Chi tiêu','Tin nhắn']",
  "['Ngày','Tài khoản QC','ID tài khoản','Thẻ / Phương thức','Chi tiêu','Tin nhắn']",
);

const filterCss = String.raw`.col-filter-btn{margin-left:6px;border:1px solid #aebbd0!important;background:#fff!important;color:#334155!important;padding:1px 6px!important;border-radius:5px!important;font-size:11px!important;line-height:18px!important;vertical-align:middle}.col-filter-btn.active{background:#1458e6!important;color:#fff!important;border-color:#1458e6!important}.excel-filter-menu{position:fixed;z-index:9999;width:300px;max-height:430px;background:#fff;border:1px solid #b8c4d6;border-radius:10px;box-shadow:0 12px 34px rgba(15,23,42,.25);padding:10px}.excel-filter-menu input[type=search]{width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:7px;margin:7px 0}.excel-filter-values{max-height:260px;overflow:auto;border:1px solid #e2e8f0;border-radius:7px;padding:5px}.excel-filter-values label{display:flex;gap:7px;align-items:flex-start;padding:5px;border-radius:5px;font-weight:400}.excel-filter-values label:hover{background:#f1f5f9}.excel-filter-actions{display:flex;justify-content:space-between;gap:7px;margin-top:9px}.excel-filter-actions button{padding:7px 9px!important}.excel-filter-title{font-weight:700}.excel-filter-count{font-size:11px;color:#64748b;margin-top:5px}th{white-space:nowrap}`;
replaceRequired("#tap{", filterCss + "#tap{", "excel_filter_css");

const oldScript = "<script>document.addEventListener('click',e=>{const x=e.target.closest('a,button,input[type=submit]');if(!x)return;const t=document.getElementById('tap');t.classList.add('show');setTimeout(()=>t.classList.remove('show'),900)},true)</script>";
const newScript = String.raw`<script>(function(){
const states=new WeakMap();let openMenu=null;
const clean=v=>(String(v||'').replace(/\s+/g,' ').trim()||'(Trống)');
function stateOf(table){if(!states.has(table))states.set(table,{filters:new Map()});return states.get(table)}
function closeMenu(){if(openMenu){openMenu.remove();openMenu=null}}
function applyFilters(table){const state=stateOf(table);const rows=[...(table.tBodies[0]?.rows||[])];let visible=0;rows.forEach(row=>{let show=true;for(const [col,selected] of state.filters){if(row.cells.length<=col||!selected.has(clean(row.cells[col].innerText))){show=false;break}}row.style.display=show?'':'none';if(show)visible++});table.querySelectorAll('thead th').forEach((th,i)=>{const b=th.querySelector('.col-filter-btn');if(b)b.classList.toggle('active',state.filters.has(i))});table.dataset.visibleRows=String(visible)}
function openFilter(table,th,col,button){closeMenu();const state=stateOf(table);const rows=[...(table.tBodies[0]?.rows||[])].filter(r=>r.cells.length>col);const values=[...new Set(rows.map(r=>clean(r.cells[col].innerText)))].sort((a,b)=>a.localeCompare(b,'vi',{numeric:true}));const current=state.filters.get(col);const menu=document.createElement('div');menu.className='excel-filter-menu';openMenu=menu;const title=document.createElement('div');title.className='excel-filter-title';title.textContent='Lọc: '+clean(th.childNodes[0]?.textContent||th.textContent);menu.appendChild(title);const search=document.createElement('input');search.type='search';search.placeholder='Tìm trong cột...';menu.appendChild(search);const list=document.createElement('div');list.className='excel-filter-values';menu.appendChild(list);const boxes=[];values.forEach(value=>{const label=document.createElement('label');const box=document.createElement('input');box.type='checkbox';box.checked=!current||current.has(value);box.dataset.value=value;const text=document.createElement('span');text.textContent=value;label.append(box,text);list.appendChild(label);boxes.push({box,label,value})});const count=document.createElement('div');count.className='excel-filter-count';count.textContent=values.length+' giá trị';menu.appendChild(count);const actions=document.createElement('div');actions.className='excel-filter-actions';const all=document.createElement('button');all.type='button';all.textContent='Chọn tất cả';const clear=document.createElement('button');clear.type='button';clear.textContent='Bỏ lọc';const apply=document.createElement('button');apply.type='button';apply.className='primary';apply.textContent='Áp dụng';actions.append(all,clear,apply);menu.appendChild(actions);document.body.appendChild(menu);const rect=button.getBoundingClientRect();const maxLeft=window.innerWidth-menu.offsetWidth-10;menu.style.left=Math.max(10,Math.min(rect.left,maxLeft))+'px';menu.style.top=Math.min(rect.bottom+5,window.innerHeight-menu.offsetHeight-10)+'px';search.addEventListener('input',()=>{const q=clean(search.value).toLowerCase();boxes.forEach(item=>item.label.style.display=item.value.toLowerCase().includes(q)?'':'none')});all.onclick=()=>boxes.forEach(item=>{if(item.label.style.display!=='none')item.box.checked=true});clear.onclick=()=>{state.filters.delete(col);applyFilters(table);closeMenu()};apply.onclick=()=>{const chosen=new Set(boxes.filter(item=>item.box.checked).map(item=>item.value));if(chosen.size===values.length)state.filters.delete(col);else state.filters.set(col,chosen);applyFilters(table);closeMenu()};menu.addEventListener('click',e=>e.stopPropagation());search.focus()}
document.querySelectorAll('table').forEach(table=>{table.querySelectorAll('thead th').forEach((th,col)=>{const button=document.createElement('button');button.type='button';button.className='col-filter-btn';button.title='Lọc cột như Excel';button.textContent='▾';button.onclick=e=>{e.stopPropagation();openFilter(table,th,col,button)};th.appendChild(button)});applyFilters(table)});
document.addEventListener('click',e=>{if(e.target.closest('.excel-filter-menu,.col-filter-btn'))return;closeMenu();const x=e.target.closest('a,button,input[type=submit]');if(!x||x.classList.contains('col-filter-btn'))return;const t=document.getElementById('tap');if(t){t.classList.add('show');setTimeout(()=>t.classList.remove('show'),900)}},true);window.addEventListener('resize',closeMenu);window.addEventListener('scroll',closeMenu,true);
})();</script>`;
replaceRequired(oldScript, newScript, "excel_filter_script");

if (!source.includes("/facebook-connect")) {
  source = source.replace(
    '<hr style="border-color:#334155">',
    '${nav(\'/facebook-connect\',\'🔐 Kết nối Facebook\',\'facebook\')}<hr style="border-color:#334155">',
  );
}

fs.writeFileSync("v7-dashboard-stable.js", source, "utf8");
console.log(
  `[AIGUKA] Stable V7 dashboard materialized: ${sourceBuffer.length} bytes · ${md5} · payment card and Excel filters restored`,
);