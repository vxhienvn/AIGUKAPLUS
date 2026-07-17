import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");

if (source.includes("AIGUKA_DAILY_STAFF_DUAL_V3")) {
  console.log("[AIGUKA] Dual daily staff statistics V3 already installed");
  process.exitCode = 0;
} else {
  const start = source.indexOf("async function dailyPage(req,res) {");
  const end = source.indexOf("async function leadsPage(req,res) {", start);
  if (start < 0 || end < 0) throw new Error("V7_DAILY_STAFF_DUAL_V3_ANCHOR_NOT_FOUND");

  const daily = String.raw`// AIGUKA_DAILY_STAFF_DUAL_V3
async function fetchMetaFirstCustomerStarts(since,until){
  if(!META_LEADS_SUPABASE_URL||!META_LEADS_SUPABASE_KEY)return{rows:[],error:"Thiếu SUPABASE_SERVICE_ROLE_KEY"};
  if(!cache.metaFirstCustomerStarts)cache.metaFirstCustomerStarts=new Map();
  const key=String(since)+":"+String(until),hit=cache.metaFirstCustomerStarts.get(key);
  if(hit&&Date.now()-hit.time<30000)return hit.data;
  const result={rows:[],error:null};
  const startIso=shiftLeadDate(since,-2)+"T00:00:00Z",endIso=shiftLeadDate(until,3)+"T00:00:00Z";
  try{
    for(let offset=0;offset<10000;offset+=1000){
      const params=new URLSearchParams();
      params.set("select","*");
      params.append("conversation_started_at","gte."+startIso);
      params.append("conversation_started_at","lt."+endIso);
      params.set("order","conversation_started_at.desc");
      params.set("limit","1000");
      params.set("offset",String(offset));
      const response=await fetch(META_LEADS_SUPABASE_URL+"/rest/v1/v8_meta_conversation_starts?"+params.toString(),{headers:{apikey:META_LEADS_SUPABASE_KEY,authorization:"Bearer "+META_LEADS_SUPABASE_KEY},signal:AbortSignal.timeout(30000),cache:"no-store"});
      const payload=await response.json().catch(()=>[]);
      if(!response.ok||!Array.isArray(payload))throw new Error(payload?.message||payload?.error||("SUPABASE_META_FIRST_STARTS_"+response.status));
      result.rows.push(...payload);
      if(payload.length<1000)break;
    }
  }catch(error){result.error=error.message}
  const data={rows:result.rows.map(row=>{
    const phones=[row.phone].filter(Boolean).map(String);
    return{
      name:row.customer_name||("Khách ..."+String(row.sender_id||"").slice(-6)),
      customer_id:String(row.sender_id||row.customer_id||""),sender_id:String(row.sender_id||""),page_id:String(row.page_id||""),page_name:row.page_name||"",
      conversation_id:String(row.conversation_id||row.sender_id||row.customer_id||""),source_type:"Meta Business",
      conversation_started_at:row.conversation_started_at,updated_at:row.last_message_at,last_customer_message_at:row.last_message_at,
      message_count:Number(row.message_count||0),has_phone:Boolean(row.has_phone||phones.length),has_zalo:Boolean(row.has_zalo),phones,
      product:row.product_key||"",hot_lead:Number(row.lead_score||0)>=60,
      tags:Array.from(new Set([...(Array.isArray(row.tags)?row.tags:[]),...(row.has_zalo?["Zalo"]:[]),...(phones.length?["Có SĐT"]:[])])),
      snippet:row.last_message_text||row.first_message_text||"",adId:String(row.ad_id||""),adName:row.ad_title||"",postId:String(row.post_id||""),
      referralSource:row.referral_source||"",isAdConversation:row.is_ad_conversation===true,
    };
  }),error:result.error};
  cache.metaFirstCustomerStarts.set(key,{time:Date.now(),data});
  return data;
}

async function dailyPage(req,res) {
  const p=period(req.query,'dashboard'),selected=String(req.query.account||'all')==='all'?'all':act(req.query.account);
  const [accounts,data,pancake,ads,firstStarts]=await Promise.all([
    getAccounts(),
    fetchDaily(p.since,p.until,selected),
    fetchPancake(3000),
    fetchAds(p.since,p.until,selected),
    fetchMetaFirstCustomerStarts(p.since,p.until),
  ]);

  const ignored=new Set(["zalo","có sđt","đã gọi","đã quét","đã quet","knm","chưa rõ sản phẩm","hẹn ra ch","hẹn ra cửa hàng","hen ra ch","hen ra cua hang","k mua","không mua"]);
  const staffTags=lead=>(lead.tags||[]).filter(tag=>{
    const normalized=String(tag||"").trim().toLowerCase();
    return normalized&&!ignored.has(normalized)&&!/^có |^không |^chưa |^đã /i.test(normalized);
  });

  // Cột cũ: toàn bộ khách mới + khách cũ có hoạt động trong ngày theo giờ Việt Nam của Pancake.
  let careLeads=mapLeads(pancake.rows||[],ads.rows||[],p.since,p.until);
  if(selected!=="all")careLeads=careLeads.filter(lead=>act(lead.accountId)===selected);
  const careByKey=new Map();
  for(const lead of careLeads){
    const date=dateKey(lead.last_customer_message_at||lead.updated_at),account=act(lead.accountId||"");
    if(!date||!account)continue;
    const customerKey=leadIdentity(lead);
    for(const name of staffTags(lead)){
      const key=date+"|"+account+"|"+name;
      const item=careByKey.get(key)||{name,customers:new Set(),contacts:new Set()};
      item.customers.add(customerKey);
      if(lead.has_phone||lead.has_zalo)item.contacts.add(customerKey);
      careByKey.set(key,item);
    }
  }
  const careHtml=(date,account)=>{
    const prefix=date+"|"+act(account)+"|";
    return [...careByKey.entries()].filter(([key])=>key.startsWith(prefix)).map(([,item])=>'<span class="staff-stat care-stat" data-staff-name="'+esc(item.name)+'"><b>'+esc(item.name)+'</b>: '+item.customers.size+' khách · '+item.contacts.size+' số</span>').join("<br>")||'<span class="muted">Chưa xác định</span>';
  };

  // Cột mới: chỉ khách bắt đầu hội thoại lần đầu trong ngày, tính theo múi giờ tài khoản quảng cáo.
  const firstCandidates=(firstStarts.rows||[]).filter(row=>row.isAdConversation&&row.adId);
  const firstAdMap=await resolveLeadAdMap(firstCandidates,ads.rows||[],accounts);
  const firstPaid=[],firstSeen=new Set(),firstUnresolved=[];
  for(const row of firstCandidates){
    const identity=leadIdentity(row);if(!identity||firstSeen.has(identity))continue;
    const ad=firstAdMap.get(String(row.adId||""));
    if(!ad?.accountId){firstUnresolved.push(row);continue}
    const account=ad.account||(accounts||[]).find(item=>act(item.id)===act(ad.accountId))||null;
    const lead={...row,accountId:act(ad.accountId),accountName:ad.accountName||account?.name||ad.accountId,accountTimezone:account?.timezoneName||account?.timezone_name||"Asia/Ho_Chi_Minh",campaignName:ad.campaignName||"",adsetName:ad.adsetName||"",adName:ad.adName||row.adName||""};
    const localDate=accountLeadDate(lead);
    if(!localDate||localDate<p.since||localDate>p.until)continue;
    if(selected!=="all"&&act(lead.accountId)!==selected)continue;
    firstSeen.add(identity);firstPaid.push(lead);
  }
  const metaLeads=enrichMetaLeadsWithPancake(firstPaid,pancake.rows||[]);
  const metaByKey=new Map(),assignedByAccountDay=new Map(),allMetaByAccountDay=new Map();
  for(const lead of metaLeads){
    const date=accountLeadDate(lead),account=act(lead.accountId||"");if(!date||!account)continue;
    const customerKey=leadIdentity(lead),groupKey=date+"|"+account;
    if(!allMetaByAccountDay.has(groupKey))allMetaByAccountDay.set(groupKey,new Set());
    allMetaByAccountDay.get(groupKey).add(customerKey);
    for(const name of staffTags(lead)){
      const key=groupKey+"|"+name,item=metaByKey.get(key)||{name,customers:new Set(),contacts:new Set()};
      item.customers.add(customerKey);if(lead.has_phone||lead.has_zalo)item.contacts.add(customerKey);metaByKey.set(key,item);
      if(!assignedByAccountDay.has(groupKey))assignedByAccountDay.set(groupKey,new Set());assignedByAccountDay.get(groupKey).add(customerKey);
    }
  }
  const metaHtml=(date,account)=>{
    const groupKey=date+"|"+act(account);
    const blocks=[...metaByKey.entries()].filter(([key])=>key.startsWith(groupKey+"|")).map(([,item])=>'<span class="staff-stat meta-new-stat" data-staff-name="'+esc(item.name)+'"><b>'+esc(item.name)+'</b>: '+item.customers.size+' khách mới · '+item.contacts.size+' số</span>');
    const total=allMetaByAccountDay.get(groupKey)?.size||0,assigned=assignedByAccountDay.get(groupKey)?.size||0,unknown=Math.max(total-assigned,0);
    if(unknown)blocks.push('<span class="staff-stat muted"><b>Chưa gắn nhân viên</b>: '+unknown+' khách mới</span>');
    return blocks.join("<br>")||'<span class="muted">Không có khách mới Meta</span>';
  };

  const byDate=new Map();for(const row of data.rows){if(!byDate.has(row.date))byDate.set(row.date,[]);byDate.get(row.date).push(row)}
  let dayNo=0;const rows=[...byDate.entries()].sort((a,b)=>b[0].localeCompare(a[0])).map(([date,items])=>{
    dayNo++;const spend=items.reduce((sum,item)=>sum+Number(item.spend||0),0),messages=items.reduce((sum,item)=>sum+Number(item.messages||0),0);
    const careTotal=items.map(item=>careHtml(date,item.accountId)).filter(html=>!html.includes("Chưa xác định")).join("<br>")||'<span class="muted">Chưa xác định</span>';
    const metaTotal=items.map(item=>metaHtml(date,item.accountId)).filter(html=>!html.includes("Không có khách mới Meta")).join("<br>")||'<span class="muted">Không có khách mới Meta</span>';
    const total='<tr class="daily-total-row" data-date="'+date+'"><td><b>'+dayNo+'</b></td><td><b>'+date+'</b></td><td><b>TỔNG NGÀY</b></td><td></td><td data-spend="'+spend+'"><b class="daily-total-money">'+money(spend)+'</b></td><td data-messages="'+messages+'"><b>'+messages+'</b></td><td>'+careTotal+'</td><td>'+metaTotal+'</td></tr>';
    const children=items.sort((a,b)=>String(a.accountName).localeCompare(String(b.accountName),"vi")).map(item=>'<tr class="daily-account-row" data-date="'+date+'"><td></td><td>'+date+'</td><td>'+esc(item.accountName)+'</td><td>'+esc(item.paymentMethod||(item.cardLast4?'Thẻ •••• '+item.cardLast4:'Trả trước / chưa đọc được thẻ'))+'</td><td data-spend="'+Number(item.spend||0)+'">'+money(item.spend)+'</td><td data-messages="'+Number(item.messages||0)+'">'+item.messages+'</td><td class="staff-cell"><div class="staff-content">'+careHtml(date,item.accountId)+'</div><button type="button" class="staff-expand">Xem thêm</button></td><td class="staff-cell"><div class="staff-content">'+metaHtml(date,item.accountId)+'</div><button type="button" class="staff-expand">Xem thêm</button></td></tr>').join("");
    return total+children;
  }).join("");

  const visibleAccounts=new Set(data.rows.map(item=>item.accountId)).size;
  const errors=[...(data.errors||[]),...(ads.errors||[]),...(firstStarts.error?[firstStarts.error]:[]),...(pancake.error?[pancake.error]:[])];
  const unresolvedNote=firstUnresolved.length?'<div class="notice">Có '+firstUnresolved.length+' khách mới chưa xác định đúng tài khoản QC nên chưa cộng vào cột Khách mới Meta.</div>':'';
  const body='<div class="top"><div><h1>Báo cáo ngày</h1><div>'+p.since+' → '+p.until+'</div><small><b>Chăm sóc trong ngày:</b> toàn bộ khách mới + cũ theo giờ Việt Nam của Pancake. <b>Khách mới Meta:</b> chỉ khách bắt đầu hội thoại lần đầu, theo múi giờ từng tài khoản QC.</small></div><a class="btn green" href="/export?type=daily&from='+p.since+'&to='+p.until+'&account='+selected+'">Xuất CSV</a></div>'+filterForm(p,accounts,selected)+(errors.length?'<div class="notice error">'+errors.map(esc).join('<br>')+'</div>':'')+unresolvedNote+'<div class="stats"><div class="stat">Tổng chi tiêu<b id="daily-visible-spend">'+money(data.totalSpend)+'</b></div><div class="stat">Hội thoại Meta<b id="daily-visible-messages">'+data.totalMessages+'</b></div><div class="stat">Tài khoản<b id="daily-visible-accounts">'+visibleAccounts+'</b></div></div><div class="card table"><table class="daily-report-table"><thead><tr><th>#</th><th>Ngày</th><th>Tài khoản QC</th><th>Thẻ / Phương thức</th><th>Chi tiêu</th><th>Hội thoại Meta</th><th>Chăm sóc trong ngày<br><small>Khách mới + cũ · giờ VN</small></th><th>Khách mới Meta<br><small>Lần đầu · giờ tài khoản QC</small></th></tr></thead><tbody>'+(rows||'<tr><td colspan="8">Không có dữ liệu.</td></tr>')+'</tbody></table></div>';
  res.type('html').send(layout('Báo cáo ngày',body,'daily'));
}

`;

  source = source.slice(0,start) + daily + source.slice(end);
  fs.writeFileSync(file,source,"utf8");
  console.log("[AIGUKA] Daily report keeps VN Pancake care counts and adds true first-time Meta customer column");
}
