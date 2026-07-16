import fs from "node:fs";
const file="v7-dashboard-stable.js";
let source=fs.readFileSync(file,"utf8");
const start=source.indexOf('    const total='+String.fromCharCode(96)+'<tr class="daily-total-row"');
const needle="    return total+children;";
const end=source.indexOf(needle,start);
if(start<0||end<0)throw Error("V7_DAILY_TOTAL_ROW_ANCHOR_NOT_FOUND");
const bt=String.fromCharCode(96);
const replacement=[
'    const children=items.sort((a,b)=>String(a.accountName).localeCompare(String(b.accountName),"vi")).map((x,index)=>'+bt+'<tr class="daily-account-row" data-date="${date}"><td class="day-number">${index===0?'+bt+'<b>${dayNo}</b>'+bt+':""}</td><td class="day-date">${index===0?date:""}</td><td>${esc(x.accountName)}</td><td>${esc(x.paymentMethod||(x.cardLast4?\'Thẻ •••• \'+x.cardLast4:\'Trả trước / chưa đọc được thẻ\'))}</td><td data-spend="${Number(x.spend||0)}"><div class="spend-split"><span class="day-total-slot">${index===0?'+bt+'<b>${money(spend)}</b>'+bt+':""}</span><span class="account-spend">${money(x.spend)}</span></div></td><td data-messages="${Number(x.messages||0)}">${x.messages}</td><td>${staffHtml(date,x.accountId)}</td></tr>'+bt+').join("");',
'    return children;'
].join("\n");
source=source.slice(0,start)+replacement+source.slice(end+needle.length);
source=source.replace("const visibleAccounts=new Set(data.rows.map(x=>x.accountId)).size;","const visibleAccounts=new Set(data.rows.map(x=>x.accountId)).size;const exactSpend=data.rows.reduce((s,x)=>s+Number(x.spend||0),0),exactMessages=data.rows.reduce((s,x)=>s+Number(x.messages||0),0);");
source=source.replace("${money(data.totalSpend)}</b></div><div class=\\\"stat\\\">Tin nhắn Meta<b id=\\\"daily-visible-messages\\\">${data.totalMessages}","${money(exactSpend)}</b></div><div class=\\\"stat\\\">Tin nhắn Meta<b id=\\\"daily-visible-messages\\\">${exactMessages}");
const css='.daily-total-row{display:none!important}.spend-split{display:grid;grid-template-columns:minmax(115px,.9fr) minmax(110px,1fr);align-items:stretch}.day-total-slot{display:flex;align-items:center;color:#155eef;font-size:15px;padding:7px 12px 7px 0}.account-spend{display:flex;align-items:center;padding:7px 0 7px 14px;border-left:1px solid #d7e0ec}.daily-account-row td{vertical-align:middle}.daily-account-row td:first-child{border-left:3px solid #b2ccff}';
source=source.replace("</style>",css+"</style>");
const script='<script id="daily-layout-sample">(function(){const table=document.querySelector(".daily-report-table");if(!table)return;const money=n=>Math.round(Number(n||0)).toLocaleString("vi-VN")+" đ";let busy=false;function refresh(){if(busy)return;busy=true;const rows=[...table.querySelectorAll("tbody tr.daily-account-row")],dates=[...new Set(rows.map(r=>r.dataset.date))],accounts=new Set();let spend=0,messages=0,dayNo=0;rows.forEach(row=>{row.cells[0].innerHTML="";row.cells[1].innerHTML="";const slot=row.querySelector(".day-total-slot");if(slot)slot.innerHTML="";if(row.style.display!=="none"){spend+=Number(row.cells[4]?.dataset.spend||0);messages+=Number(row.cells[5]?.dataset.messages||0);accounts.add(row.cells[2]?.innerText.trim())}});dates.forEach(date=>{const visible=rows.filter(r=>r.dataset.date===date&&r.style.display!=="none");if(!visible.length)return;dayNo++;const sum=visible.reduce((n,r)=>n+Number(r.cells[4]?.dataset.spend||0),0);visible[0].cells[0].innerHTML="<b>"+dayNo+"</b>";visible[0].cells[1].innerHTML="<b>"+date+"</b>";const slot=visible[0].querySelector(".day-total-slot");if(slot)slot.innerHTML="<b>"+money(sum)+"</b>"});document.getElementById("daily-visible-spend").textContent=money(spend);document.getElementById("daily-visible-messages").textContent=String(messages);document.getElementById("daily-visible-accounts").textContent=String(accounts.size);busy=false}new MutationObserver(refresh).observe(table.tBodies[0],{subtree:true,attributes:true,attributeFilter:["style"]});setTimeout(refresh,0)})();</script>';
source=source.replace("</body>",script+"</body>");
fs.writeFileSync(file,source,"utf8");
console.log("[AIGUKA] Daily report sample layout applied without a separate total row");
