import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_DAILY_FINAL_LAYOUT_V5";

if (source.includes(marker)) {
  console.log("[AIGUKA] Final daily layout V5 already installed");
} else {
  const start = source.indexOf("async function dailyPage(req,res)");
  let end = source.indexOf("async function fetchMetaAdReferralEntries", start);
  if (end < 0) end = source.indexOf("async function leadsPage(req,res)", start);
  if (start < 0 || end < 0) throw new Error("DAILY_FINAL_ROUTE_ANCHOR_NOT_FOUND");

  const daily = String.raw`// AIGUKA_DAILY_FINAL_LAYOUT_V5
async function dailyPage(req,res) {
  const startedAt=Date.now();
  const p=period(req.query,'dashboard'),selected=String(req.query.account||'all')==='all'?'all':act(req.query.account);

  const fetchPancakeRange=async()=>{
    if(!cache.dailyPancakeRange)cache.dailyPancakeRange=new Map();
    const rangeKey=String(p.since)+'|'+String(p.until);
    const cached=cache.dailyPancakeRange.get(rangeKey);
    if(cached&&Date.now()-cached.time<60000)return cached.data;
    const supabaseUrl=String(process.env.SUPABASE_URL||'').replace(/\/$/,'');
    const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
    if(!supabaseUrl||!serviceKey)return fetchPancake(3000);
    try{
      const startIso=shiftLeadDate(p.since,-1)+'T00:00:00Z',endIso=shiftLeadDate(p.until,2)+'T00:00:00Z';
      const raw=[];
      for(let offset=0;offset<10000;offset+=1000){
        const params=new URLSearchParams();
        params.set('select','conversation_id,page_id,customer_id,staff_tags,last_customer_message_at,updated_at,conversation');
        params.append('last_customer_message_at','gte.'+startIso);
        params.append('last_customer_message_at','lt.'+endIso);
        params.set('order','last_customer_message_at.desc.nullslast');
        params.set('limit','1000');params.set('offset',String(offset));
        const response=await fetch(supabaseUrl+'/rest/v1/v8_pancake_conversation_cache?'+params.toString(),{headers:{apikey:serviceKey,authorization:'Bearer '+serviceKey},signal:AbortSignal.timeout(20000),cache:'no-store'});
        const batch=await response.json().catch(()=>[]);
        if(!response.ok||!Array.isArray(batch))throw new Error(batch?.message||batch?.error||('PANCAKE_RANGE_'+response.status));
        raw.push(...batch);if(batch.length<1000)break;
      }
      const rows=raw.map(item=>{
        const conversation=item&&item.conversation&&typeof item.conversation==='object'?{...item.conversation}:{};
        conversation.id=conversation.id||item.conversation_id;
        conversation.page_id=conversation.page_id||item.page_id;
        conversation.customer_id=conversation.customer_id||item.customer_id;
        conversation.staff_tags=pancakeUniqueText([...(conversation.staff_tags||[]),...(item.staff_tags||[])]);
        conversation.last_customer_message_at=conversation.last_customer_message_at||item.last_customer_message_at;
        conversation.updated_at=conversation.updated_at||item.updated_at||item.last_customer_message_at;
        const built=pancakeBuildCustomerRow(conversation);
        const tags=pancakeUniqueText([...(built.tags||[]),...(item.staff_tags||[])]);
        return{...built,page_id:String(item.page_id||built.page_id||''),sender_id:pancakeSenderId(built)||String(item.customer_id||''),customer_id:pancakeSenderId(built)||String(item.customer_id||built.customer_id||''),conversation_id:built.conversation_id||item.conversation_id,tags,pancake_tags:pancakeUniqueText([...(built.pancake_tags||[]),...(item.staff_tags||[])]),has_zalo:Boolean(built.has_zalo||tags.some(tag=>String(tag).toLowerCase()==='zalo'))};
      });
      const result={rows:pancakeCompleteCustomerTags(rows),error:null};
      cache.dailyPancakeRange.set(rangeKey,{time:Date.now(),data:result});
      return result;
    }catch(_error){return fetchPancake(3000)}
  };

  const [accounts,data,pancake,ads,firstStarts]=await Promise.all([
    getAccounts(),fetchDaily(p.since,p.until,selected),fetchPancakeRange(),fetchAds(p.since,p.until,selected),fetchMetaFirstCustomerStarts(p.since,p.until)
  ]);
  const dailyRows=Array.isArray(data&&data.rows)?data.rows:[];
  const pancakeRows=Array.isArray(pancake&&pancake.rows)?pancake.rows:[];
  const adRows=Array.isArray(ads&&ads.rows)?ads.rows:[];
  const firstRows=Array.isArray(firstStarts&&firstStarts.rows)?firstStarts.rows:[];

  const ignored=new Set(['zalo','có sđt','đã gọi','đã quét','đã quet','knm','chưa rõ sản phẩm','hẹn ra ch','hẹn ra cửa hàng','hen ra ch','hen ra cua hang','k mua','không mua','tag removed','removed tag','tag deleted','xóa tag','xoá tag']);
  const staffTags=lead=>(lead.tags||[]).filter(tag=>{const normalized=String(tag||'').normalize('NFKC').trim().toLocaleLowerCase('vi');return normalized&&!ignored.has(normalized)&&!/^có |^không |^chưa |^đã /i.test(normalized)});

  let careLeads=mapLeads(pancakeRows,adRows,p.since,p.until);
  if(selected!=='all')careLeads=careLeads.filter(lead=>act(lead.accountId)===selected);
  const careByKey=new Map();
  for(const lead of careLeads){
    const date=dateKey(lead.last_customer_message_at||lead.updated_at),account=act(lead.accountId||'');
    if(!date||!account)continue;
    const customerKey=leadIdentity(lead);
    for(const name of staffTags(lead)){
      const key=date+'|'+account+'|'+name,item=careByKey.get(key)||{name,customers:new Set(),contacts:new Set()};
      item.customers.add(customerKey);if(lead.has_phone||lead.has_zalo)item.contacts.add(customerKey);careByKey.set(key,item);
    }
  }
  const careHtml=(date,account)=>{
    const prefix=date+'|'+act(account)+'|';
    const items=[...careByKey.entries()].filter(([key])=>key.startsWith(prefix)).map(([,item])=>item).sort((a,b)=>String(a.name).localeCompare(String(b.name),'vi'));
    return items.length?items.map(item=>'<span class="staff-stat care-stat" data-staff-name="'+esc(item.name)+'"><b>'+esc(item.name)+'</b>: '+item.customers.size+' khách · '+item.contacts.size+' số</span>').join('<br>'):'<span class="muted">Chưa xác định</span>';
  };

  const firstCandidates=firstRows.filter(row=>row.isAdConversation&&row.adId);
  const firstAdMap=await resolveLeadAdMap(firstCandidates,adRows,accounts);
  const firstPaid=[],firstSeen=new Set();
  for(const row of firstCandidates){
    const identity=leadIdentity(row);if(!identity||firstSeen.has(identity))continue;
    const ad=firstAdMap.get(String(row.adId||''));if(!ad||!ad.accountId)continue;
    const account=ad.account||(accounts||[]).find(item=>act(item.id)===act(ad.accountId))||null;
    const lead={...row,accountId:act(ad.accountId),accountName:ad.accountName||account?.name||ad.accountId,accountTimezone:account?.timezoneName||account?.timezone_name||'Asia/Ho_Chi_Minh',campaignName:ad.campaignName||'',adsetName:ad.adsetName||'',adName:ad.adName||row.adName||''};
    const localDate=accountLeadDate(lead);if(!localDate||localDate<p.since||localDate>p.until)continue;
    if(selected!=='all'&&act(lead.accountId)!==selected)continue;
    firstSeen.add(identity);firstPaid.push(lead);
  }
  const metaLeads=enrichMetaLeadsWithPancake(firstPaid,pancakeRows);
  const metaByKey=new Map(),assignedByAccountDay=new Map(),allMetaByAccountDay=new Map();
  for(const lead of metaLeads){
    const date=accountLeadDate(lead),account=act(lead.accountId||'');if(!date||!account)continue;
    const customerKey=leadIdentity(lead),groupKey=date+'|'+account;
    if(!allMetaByAccountDay.has(groupKey))allMetaByAccountDay.set(groupKey,new Set());allMetaByAccountDay.get(groupKey).add(customerKey);
    for(const name of staffTags(lead)){
      const key=groupKey+'|'+name,item=metaByKey.get(key)||{name,customers:new Set(),contacts:new Set()};
      item.customers.add(customerKey);if(lead.has_phone||lead.has_zalo)item.contacts.add(customerKey);metaByKey.set(key,item);
      if(!assignedByAccountDay.has(groupKey))assignedByAccountDay.set(groupKey,new Set());assignedByAccountDay.get(groupKey).add(customerKey);
    }
  }
  const metaHtml=(date,account)=>{
    const groupKey=date+'|'+act(account),items=[...metaByKey.entries()].filter(([key])=>key.startsWith(groupKey+'|')).map(([,item])=>item).sort((a,b)=>String(a.name).localeCompare(String(b.name),'vi'));
    const blocks=items.map(item=>'<span class="staff-stat meta-new-stat" data-staff-name="'+esc(item.name)+'"><b>'+esc(item.name)+'</b>: '+item.customers.size+' khách mới · '+item.contacts.size+' số</span>');
    const total=allMetaByAccountDay.get(groupKey)?.size||0,assigned=assignedByAccountDay.get(groupKey)?.size||0,unknown=Math.max(total-assigned,0);
    if(unknown)blocks.push('<span class="staff-stat muted"><b>Chưa gắn nhân viên</b>: '+unknown+' khách mới</span>');
    return blocks.join('<br>')||'<span class="muted">Không có khách mới Meta</span>';
  };

  const byDate=new Map();for(const row of dailyRows){if(!byDate.has(row.date))byDate.set(row.date,[]);byDate.get(row.date).push(row)}
  let dayNo=0;
  const rows=[...byDate.entries()].sort((a,b)=>b[0].localeCompare(a[0])).map(([date,items])=>{
    dayNo++;
    const sorted=items.sort((a,b)=>String(a.accountName).localeCompare(String(b.accountName),'vi'));
    const daySpend=sorted.reduce((sum,item)=>sum+Number(item.spend||0),0),dayMessages=sorted.reduce((sum,item)=>sum+Number(item.messages||0),0),span=sorted.length;
    return sorted.map((item,index)=>{
      const accountSpend=Number(item.spend||0),accountMessages=Number(item.messages||0),groupStyle=index===0?'':' style="display:none"';
      return '<tr class="daily-account-row" data-date="'+esc(date)+'" data-day-no="'+dayNo+'" data-account-id="'+esc(act(item.accountId||''))+'" data-account-name="'+esc(item.accountName||'')+'" data-spend="'+accountSpend+'" data-messages="'+accountMessages+'">'
        +'<td class="daily-group-cell daily-seq" rowspan="'+(index===0?span:1)+'"'+groupStyle+'><b>'+dayNo+'</b></td>'
        +'<td class="daily-group-cell daily-date" rowspan="'+(index===0?span:1)+'"'+groupStyle+'><b>'+esc(date)+'</b></td>'
        +'<td class="account-name-cell">'+esc(item.accountName)+'</td>'
        +'<td class="payment-method-cell">'+esc(item.paymentMethod||(item.cardLast4?'Thẻ •••• '+item.cardLast4:'Trả trước / chưa đọc được thẻ'))+'</td>'
        +'<td class="account-spend-cell" data-spend="'+accountSpend+'">'+money(accountSpend)+'</td>'
        +'<td class="daily-group-cell daily-total-spend" rowspan="'+(index===0?span:1)+'"'+groupStyle+'><b>'+money(daySpend)+'</b></td>'
        +'<td class="account-message-cell" data-messages="'+accountMessages+'">'+accountMessages+'</td>'
        +'<td class="daily-group-cell daily-total-messages" rowspan="'+(index===0?span:1)+'"'+groupStyle+'><b>'+dayMessages+'</b></td>'
        +'<td class="staff-cell"><div class="staff-line"><div class="staff-content">'+careHtml(date,item.accountId)+'</div><button type="button" class="staff-expand">Xem thêm</button></div></td>'
        +'<td class="staff-cell"><div class="staff-line"><div class="staff-content">'+metaHtml(date,item.accountId)+'</div><button type="button" class="staff-expand">Xem thêm</button></div></td>'
        +'</tr>';
    }).join('');
  }).join('');

  const exactSpend=dailyRows.reduce((sum,item)=>sum+Number(item.spend||0),0),exactMessages=dailyRows.reduce((sum,item)=>sum+Number(item.messages||0),0),visibleAccounts=new Set(dailyRows.map(item=>act(item.accountId||''))).size;
  const body='<div class="top"><div><h1>Báo cáo ngày</h1><div>'+p.since+' → '+p.until+'</div><small><b>Chăm sóc trong ngày:</b> khách mới + khách cũ theo giờ Việt Nam. <b>Khách mới Meta:</b> khách bắt đầu hội thoại lần đầu theo múi giờ tài khoản QC.</small></div><a class="btn green" href="/export?type=daily&from='+p.since+'&to='+p.until+'&account='+selected+'">Xuất CSV</a></div>'
    +filterForm(p,accounts,selected)
    +'<div class="stats"><div class="stat">Tổng chi tiêu<b id="daily-visible-spend">'+money(exactSpend)+'</b></div><div class="stat">Hội thoại Meta<b id="daily-visible-messages">'+exactMessages+'</b></div><div class="stat">Tài khoản<b id="daily-visible-accounts">'+visibleAccounts+'</b></div></div>'
    +'<div class="card table"><table class="daily-report-table"><thead><tr><th>#</th><th>Ngày</th><th>Tài khoản QC</th><th>Thẻ / Phương thức</th><th>Chi tiêu</th><th>Tổng chi tiêu</th><th>Hội thoại Meta</th><th>Tổng hội thoại</th><th>Chăm sóc trong ngày<br><small>Khách mới + cũ · giờ VN</small></th><th>Khách mới Meta<br><small>Lần đầu · giờ tài khoản QC</small></th></tr></thead><tbody>'+(rows||'<tr><td colspan="10">Không có dữ liệu.</td></tr>')+'</tbody></table></div>';
  res.setHeader('Server-Timing','daily;dur='+(Date.now()-startedAt));
  res.type('html').send(layout('Báo cáo ngày',body,'daily'));
}

`;

  source = source.slice(0, start) + daily + source.slice(end);

  source = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, block => {
    const isDailyScript = /daily-report-table/.test(block) && /daily-visible-(?:spend|messages|accounts)|daily-layout-sample|daily-total-row/.test(block);
    return isDailyScript ? "" : block;
  });

  const css = String.raw`
/* AIGUKA_DAILY_FINAL_LAYOUT_V5 */
.daily-report-table{border-collapse:collapse!important;min-width:1450px!important}.daily-report-table th{background:#eaf0f7!important;border:1px solid #b7c4d6!important;padding:8px 9px!important;vertical-align:middle!important}.daily-report-table td{border:1px solid #cbd5e1!important;padding:7px 9px!important;vertical-align:middle!important}.daily-account-row:hover td{background:#f8fbff}.daily-group-cell{text-align:center!important;vertical-align:middle!important;background:#fff!important}.daily-seq{width:42px;font-weight:700}.daily-date{min-width:112px}.daily-total-spend{min-width:125px;color:#111827!important;font-size:17px!important;font-weight:800!important}.daily-total-spend b{color:#111827!important}.daily-total-messages{min-width:82px;font-size:16px;font-weight:800}.account-spend-cell,.payment-method-cell{white-space:nowrap}.staff-cell{min-width:245px;position:relative}.staff-line{display:flex;align-items:center;gap:6px}.staff-content{max-height:23px;overflow:hidden;line-height:21px;white-space:nowrap}.staff-cell.expanded .staff-line{align-items:flex-start}.staff-cell.expanded .staff-content{max-height:none;white-space:normal}.staff-expand{display:none;flex:0 0 auto;padding:2px 7px!important;border:1px solid #98a2b3!important;border-radius:5px!important;background:#fff!important;color:#344054!important;font-size:11px!important}.staff-cell.has-more .staff-expand{display:inline-block}.staff-stat{display:inline-block;padding:2px 5px;border-radius:5px;background:#f2f4f7;margin:1px 0}.daily-report-table small{font-size:11px;color:#475467}.stats .stat b{min-height:29px}.daily-account-row[style*="display: none"]{display:none!important}
`;
  source = source.replace("</style>", css + "</style>");

  const script = String.raw`<script id="daily-final-layout-v5">(function(){
const table=document.querySelector('.daily-report-table');if(!table)return;const tbody=table.tBodies[0],rows=[...tbody.querySelectorAll('tr.daily-account-row')];if(!rows.length)return;
const money=n=>Math.round(Number(n||0)).toLocaleString('vi-VN')+' đ';
let timer=0;function visible(row){return row.style.display!=='none'&&getComputedStyle(row).display!=='none'}
function groupCells(row){return['.daily-seq','.daily-date','.daily-total-spend','.daily-total-messages'].map(s=>row.querySelector(s))}
function refresh(){
  const groups=new Map();rows.forEach(row=>{const key=row.dataset.date||'';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)});
  let totalSpend=0,totalMessages=0;const accounts=new Set();
  for(const [date,group] of groups){
    group.forEach(row=>groupCells(row).forEach(cell=>{if(cell){cell.style.display='';cell.rowSpan=1}}));
    const active=group.filter(visible);
    group.filter(row=>!active.includes(row)).forEach(row=>groupCells(row).forEach(cell=>{if(cell)cell.style.display='none'}));
    if(!active.length)continue;
    const spend=active.reduce((sum,row)=>sum+Number(row.dataset.spend||0),0),messages=active.reduce((sum,row)=>sum+Number(row.dataset.messages||0),0),first=active[0];
    totalSpend+=spend;totalMessages+=messages;active.forEach(row=>accounts.add(row.dataset.accountName||row.dataset.accountId||''));
    const firstCells=groupCells(first);firstCells.forEach(cell=>{if(cell){cell.style.display='';cell.rowSpan=active.length}});
    if(firstCells[0])firstCells[0].innerHTML='<b>'+String(first.dataset.dayNo||'')+'</b>';
    if(firstCells[1])firstCells[1].innerHTML='<b>'+date+'</b>';
    if(firstCells[2])firstCells[2].innerHTML='<b>'+money(spend)+'</b>';
    if(firstCells[3])firstCells[3].innerHTML='<b>'+messages+'</b>';
    active.slice(1).forEach(row=>groupCells(row).forEach(cell=>{if(cell)cell.style.display='none'}));
  }
  const a=document.getElementById('daily-visible-spend'),b=document.getElementById('daily-visible-messages'),c=document.getElementById('daily-visible-accounts');
  if(a)a.textContent=money(totalSpend);if(b)b.textContent=String(totalMessages);if(c)c.textContent=String([...accounts].filter(Boolean).length);
  document.querySelectorAll('.staff-cell').forEach(cell=>{const content=cell.querySelector('.staff-content');cell.classList.toggle('has-more',Boolean(content&&content.scrollHeight>content.clientHeight+2))});
}
function schedule(){clearTimeout(timer);timer=setTimeout(refresh,20)}
const observer=new MutationObserver(schedule);rows.forEach(row=>observer.observe(row,{attributes:true,attributeFilter:['style']}));
document.addEventListener('click',event=>{const button=event.target.closest('.staff-expand');if(!button)return;const cell=button.closest('.staff-cell');cell.classList.toggle('expanded');button.textContent=cell.classList.contains('expanded')?'Thu gọn':'Xem thêm'});
refresh();
})();</script>`;
  source = source.replace("</body>", script + "</body>");

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`DAILY_FINAL_SYNTAX_FAILED:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Daily totals, merged layout and range-limited Pancake loading restored");
}
