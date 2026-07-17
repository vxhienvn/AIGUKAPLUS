import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");

if (source.includes("AIGUKA_DAILY_STAFF_ALIGNED_V1")) {
  console.log("[AIGUKA] Daily staff statistics already aligned");
  process.exitCode = 0;
} else {
  const start = source.indexOf("async function dailyPage(req,res) {");
  const end = source.indexOf("async function leadsPage(req,res) {", start);
  if (start < 0 || end < 0) throw new Error("V7_DAILY_STAFF_ALIGNED_ANCHOR_NOT_FOUND");

  const daily = String.raw`// AIGUKA_DAILY_STAFF_ALIGNED_V1
async function dailyPage(req,res) {
  const p=period(req.query,'dashboard'),selected=String(req.query.account||'all')==='all'?'all':act(req.query.account);
  const [accounts,data,leadReport]=await Promise.all([
    getAccounts(),
    fetchDaily(p.since,p.until,selected),
    loadUnifiedLeadReport(p,selected),
  ]);
  const leads=leadReport.leads||[];
  const ignored=new Set(["zalo","có sđt","đã gọi","đã quét","đã quet","knm","chưa rõ sản phẩm","hẹn ra ch","hẹn ra cửa hàng","hen ra ch","hen ra cua hang","k mua","không mua"]);
  const staffByKey=new Map();
  const assignedByAccountDay=new Map();
  const allLeadByAccountDay=new Map();
  for(const lead of leads){
    const date=accountLeadDate(lead),account=act(lead.accountId||"");
    if(!date||!account)continue;
    const leadKey=leadIdentity(lead);
    const groupKey=date+"|"+account;
    if(!allLeadByAccountDay.has(groupKey))allLeadByAccountDay.set(groupKey,new Set());
    allLeadByAccountDay.get(groupKey).add(leadKey);
    const staff=(lead.tags||[]).filter(tag=>{
      const normalized=String(tag||"").trim().toLowerCase();
      return normalized&&!ignored.has(normalized)&&!/^có |^không |^chưa |^đã /i.test(normalized);
    });
    for(const name of staff){
      const key=groupKey+"|"+name;
      const item=staffByKey.get(key)||{name,customers:new Set(),contacts:new Set()};
      item.customers.add(leadKey);
      if(lead.has_phone||lead.has_zalo)item.contacts.add(leadKey);
      staffByKey.set(key,item);
      if(!assignedByAccountDay.has(groupKey))assignedByAccountDay.set(groupKey,new Set());
      assignedByAccountDay.get(groupKey).add(leadKey);
    }
  }
  const staffHtml=(date,account)=>{
    const groupKey=date+"|"+act(account);
    const blocks=[...staffByKey.entries()]
      .filter(([key])=>key.startsWith(groupKey+"|"))
      .map(([,item])=>'<span class="staff-stat" data-staff-name="'+esc(item.name)+'"><b>'+esc(item.name)+'</b>: '+item.customers.size+' khách · '+item.contacts.size+' số</span>');
    const total=allLeadByAccountDay.get(groupKey)?.size||0;
    const assigned=assignedByAccountDay.get(groupKey)?.size||0;
    const unknown=Math.max(total-assigned,0);
    if(unknown)blocks.push('<span class="staff-stat muted"><b>Chưa gắn nhân viên</b>: '+unknown+' khách</span>');
    return blocks.join("<br>")||'<span class="muted">Chưa có khách quảng cáo</span>';
  };
  const byDate=new Map();for(const row of data.rows){if(!byDate.has(row.date))byDate.set(row.date,[]);byDate.get(row.date).push(row)}
  let dayNo=0;const rows=[...byDate.entries()].sort((a,b)=>b[0].localeCompare(a[0])).map(([date,items])=>{
    dayNo++;const spend=items.reduce((sum,item)=>sum+Number(item.spend||0),0),messages=items.reduce((sum,item)=>sum+Number(item.messages||0),0);
    const allStaff=items.map(item=>staffHtml(date,item.accountId)).filter(html=>!html.includes("Chưa có khách quảng cáo")).join("<br>")||'<span class="muted">Chưa có khách quảng cáo</span>';
    const total='<tr class="daily-total-row" data-date="'+date+'"><td><b>'+dayNo+'</b></td><td><b>'+date+'</b></td><td><b>TỔNG NGÀY</b></td><td></td><td data-spend="'+spend+'"><b class="daily-total-money">'+money(spend)+'</b></td><td data-messages="'+messages+'"><b>'+messages+'</b></td><td>'+allStaff+'</td></tr>';
    const children=items.sort((a,b)=>String(a.accountName).localeCompare(String(b.accountName),"vi")).map(item=>'<tr class="daily-account-row" data-date="'+date+'"><td></td><td>'+date+'</td><td>'+esc(item.accountName)+'</td><td>'+esc(item.paymentMethod||(item.cardLast4?'Thẻ •••• '+item.cardLast4:'Trả trước / chưa đọc được thẻ'))+'</td><td data-spend="'+Number(item.spend||0)+'">'+money(item.spend)+'</td><td data-messages="'+Number(item.messages||0)+'">'+item.messages+'</td><td class="staff-cell"><div class="staff-content">'+staffHtml(date,item.accountId)+'</div><button type="button" class="staff-expand">Xem thêm</button></td></tr>').join("");
    return total+children;
  }).join("");
  const visibleAccounts=new Set(data.rows.map(item=>item.accountId)).size;
  const body='<div class="top"><div><h1>Báo cáo ngày</h1><div>'+p.since+' → '+p.until+' · Cột nhân viên tính theo khách quảng cáo duy nhất, cùng múi giờ tài khoản QC</div></div><a class="btn green" href="/export?type=daily&from='+p.since+'&to='+p.until+'&account='+selected+'">Xuất CSV</a></div>'+filterForm(p,accounts,selected)+(data.errors.length?'<div class="notice error">'+data.errors.map(esc).join('<br>')+'</div>':'')+'<div class="stats"><div class="stat">Tổng chi tiêu<b id="daily-visible-spend">'+money(data.totalSpend)+'</b></div><div class="stat">Hội thoại Meta<b id="daily-visible-messages">'+data.totalMessages+'</b></div><div class="stat">Tài khoản<b id="daily-visible-accounts">'+visibleAccounts+'</b></div></div><div class="card table"><table class="daily-report-table"><thead><tr><th>#</th><th>Ngày</th><th>Tài khoản QC</th><th>Thẻ / Phương thức</th><th>Chi tiêu</th><th>Hội thoại</th><th>Nhân viên phụ trách khách</th></tr></thead><tbody>'+(rows||'<tr><td colspan="7">Không có dữ liệu.</td></tr>')+'</tbody></table></div>';
  res.type('html').send(layout('Báo cáo ngày',body,'daily'));
}

`;

  source = source.slice(0,start) + daily + source.slice(end);
  fs.writeFileSync(file,source,"utf8");
  console.log("[AIGUKA] Daily staff counts aligned to unique ad customers and account timezone");
}
