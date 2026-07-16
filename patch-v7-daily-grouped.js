import fs from "node:fs";
const file="v7-dashboard-stable.js";
let source=fs.readFileSync(file,"utf8");
const start=source.indexOf("async function dailyPage(req,res) {");
const end=source.indexOf("async function leadsPage(req,res) {",start);
if(start<0||end<0)throw Error("V7_DAILY_PAGE_ANCHOR_NOT_FOUND");
const fn=`async function dailyPage(req,res) {
  const p=period(req.query,'dashboard'),selected=String(req.query.account||'all')==='all'?'all':act(req.query.account);
  const [accounts,data,pancake,ads]=await Promise.all([getAccounts(),fetchDaily(p.since,p.until,selected),fetchPancake(500),fetchAds(p.since,p.until,selected)]);
  let leads=mapLeads(pancake.rows,ads.rows,p.since,p.until);if(selected!=='all')leads=leads.filter(x=>act(x.accountId)===selected);
  const ignored=new Set(["zalo","có sđt","đã gọi","đã quét","đã quet" ,"knm","chưa rõ sản phẩm"]);
  const staffByKey=new Map();
  for(const lead of leads){
    const date=dateKey(lead.last_customer_message_at||lead.updated_at),account=act(lead.accountId||"");
    const staff=(lead.tags||[]).filter(t=>{const n=String(t||"").trim().toLowerCase();return n&&!ignored.has(n)&&!/^có |^không |^chưa |^đã /i.test(n)});
    for(const name of staff){
      const key=date+"|"+account+"|"+name;const x=staffByKey.get(key)||{name,messages:0,phones:0};x.messages+=1;if(lead.has_phone||lead.has_zalo)x.phones+=1;staffByKey.set(key,x);
    }
  }
  const staffHtml=(date,account)=>[...staffByKey.entries()].filter(([k])=>k.startsWith(date+"|"+act(account)+"|")).map(([,x])=>\`<span class="staff-stat"><b>\${esc(x.name)}</b>: \${x.messages} tin · \${x.phones} số</span>\`).join("<br>")||'<span class="muted">Chưa xác định</span>';
  const byDate=new Map();for(const row of data.rows){if(!byDate.has(row.date))byDate.set(row.date,[]);byDate.get(row.date).push(row)}
  let dayNo=0;const rows=[...byDate.entries()].sort((a,b)=>b[0].localeCompare(a[0])).map(([date,items])=>{
    dayNo++;const spend=items.reduce((s,x)=>s+Number(x.spend||0),0),messages=items.reduce((s,x)=>s+Number(x.messages||0),0);
    const allStaff=items.map(x=>staffHtml(date,x.accountId)).filter(x=>!x.includes("Chưa xác định")).join("<br>")||'<span class="muted">Chưa xác định</span>';
    const total=\`<tr class="daily-total-row" data-date="\${date}"><td><b>\${dayNo}</b></td><td><b>\${date}</b></td><td><b>TỔNG NGÀY</b></td><td></td><td data-spend="\${spend}"><b class="daily-total-money">\${money(spend)}</b></td><td data-messages="\${messages}"><b>\${messages}</b></td><td>\${allStaff}</td></tr>\`;
    const children=items.sort((a,b)=>String(a.accountName).localeCompare(String(b.accountName),"vi")).map(x=>\`<tr class="daily-account-row" data-date="\${date}"><td></td><td>\${date}</td><td>\${esc(x.accountName)}</td><td>\${esc(x.paymentMethod||(x.cardLast4?'Thẻ •••• '+x.cardLast4:'Trả trước / chưa đọc được thẻ'))}</td><td data-spend="\${Number(x.spend||0)}">\${money(x.spend)}</td><td data-messages="\${Number(x.messages||0)}">\${x.messages}</td><td>\${staffHtml(date,x.accountId)}</td></tr>\`).join("");
    return total+children;
  }).join("");
  const visibleAccounts=new Set(data.rows.map(x=>x.accountId)).size;
  const body=\`<div class="top"><div><h1>Báo cáo ngày</h1><div>\${p.since} → \${p.until}</div></div><a class="btn green" href="/export?type=daily&from=\${p.since}&to=\${p.until}&account=\${selected}">Xuất CSV</a></div>\${filterForm(p,accounts,selected)}\${data.errors.length?\`<div class="notice error">\${data.errors.map(esc).join('<br>')}</div>\`:''}<div class="stats"><div class="stat">Tổng chi tiêu<b id="daily-visible-spend">\${money(data.totalSpend)}</b></div><div class="stat">Tin nhắn Meta<b id="daily-visible-messages">\${data.totalMessages}</b></div><div class="stat">Tài khoản<b id="daily-visible-accounts">\${visibleAccounts}</b></div></div><div class="card table"><table class="daily-report-table"><thead><tr><th>#</th><th>Ngày</th><th>Tài khoản QC</th><th>Thẻ / Phương thức</th><th>Chi tiêu</th><th>Tin nhắn</th><th>Nhân viên</th></tr></thead><tbody>\${rows||'<tr><td colspan="7">Không có dữ liệu.</td></tr>'}</tbody></table></div>\`;res.type('html').send(layout('Báo cáo ngày',body,'daily'));
}

`;
source=source.slice(0,start)+fn+source.slice(end);
const css=`.daily-total-row{background:#eaf2ff!important;border-top:2px solid #155eef}.daily-total-row td{color:#102a56}.daily-total-money{color:#155eef;font-size:15px}.daily-account-row td:first-child{border-left:3px solid #b2ccff}.staff-stat{display:inline-block;padding:2px 6px;border-radius:6px;background:#f2f4f7;margin:1px 0}`;
source=source.replace("</style>",css+"</style>");
const script=`<script>(function(){const table=document.querySelector(".daily-report-table");if(!table)return;const money=n=>Math.round(n).toLocaleString("vi-VN")+" đ";let busy=false;function update(){if(busy)return;busy=true;let spend=0,messages=0;const accounts=new Set();const children=[...table.querySelectorAll("tbody tr.daily-account-row")];for(const row of children){if(row.style.display==="none")continue;spend+=Number(row.cells[4]?.dataset.spend||0);messages+=Number(row.cells[5]?.dataset.messages||0);accounts.add(row.cells[2]?.innerText.trim())}for(const total of table.querySelectorAll("tbody tr.daily-total-row")){const active=children.filter(r=>r.dataset.date===total.dataset.date&&r.style.display!=="none");total.style.display=active.length?"":"none";if(active.length){const s=active.reduce((n,r)=>n+Number(r.cells[4]?.dataset.spend||0),0),m=active.reduce((n,r)=>n+Number(r.cells[5]?.dataset.messages||0),0);total.cells[4].innerHTML="<b class='daily-total-money'>"+money(s)+"</b>";total.cells[5].innerHTML="<b>"+m+"</b>"}}document.getElementById("daily-visible-spend").textContent=money(spend);document.getElementById("daily-visible-messages").textContent=String(messages);document.getElementById("daily-visible-accounts").textContent=String(accounts.size);busy=false}new MutationObserver(update).observe(table.tBodies[0],{subtree:true,attributes:true,attributeFilter:["style"]});setTimeout(update,0)})();</script>`;
source=source.replace("</body>",script+"</body>");
fs.writeFileSync(file,source,"utf8");
console.log("[AIGUKA] Daily report grouped by date; visible totals and staff statistics enabled");
