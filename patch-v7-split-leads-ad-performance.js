import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_SPLIT_LEADS_AD_PERFORMANCE_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Leads and ad performance pages already split");
} else {
  if (!source.includes("AIGUKA_LEAD_META_INSIGHTS_TRUTH_V1")) {
    throw new Error("SPLIT_LEADS_REQUIRES_META_INSIGHTS_TRUTH");
  }

  const pageStart = source.indexOf("async function leadsPage(req,res) {");
  const installStart = source.indexOf("export function installStableV7Dashboard", pageStart);
  if (pageStart < 0 || installStart < 0) {
    throw new Error("SPLIT_LEADS_PAGE_ANCHOR_NOT_FOUND");
  }

  const pages = String.raw`// AIGUKA_SPLIT_LEADS_AD_PERFORMANCE_V1
function usableLeadName(value) {
  const text=String(value||'').replace(/\s+/g,' ').trim();
  if(!text||/^\d+$/.test(text))return false;
  if(/^khách(?:\s|\.|$)/i.test(text)||/^facebook user/i.test(text)||/^unknown$/i.test(text))return false;
  return true;
}

function pancakeLeadNameMap(rows) {
  const map=new Map();
  for(const row of rows||[]){
    const key=leadIdentity(row);
    if(!key||key==='name|')continue;
    const name=[row.name,row.customer_name,row.display_name,row.full_name].find(usableLeadName)||'';
    if(!name)continue;
    const time=new Date(row.last_customer_message_at||row.updated_at||row.created_at||0).getTime()||0;
    const current=map.get(key);
    if(!current||time>=current.time)map.set(key,{name,time});
  }
  return map;
}

function resolvedLeadName(lead,pancakeNames) {
  const metaName=[lead.customer_name,lead.name].find(usableLeadName);
  if(metaName)return String(metaName).trim();
  const pancake=pancakeNames.get(leadIdentity(lead));
  return pancake&&usableLeadName(pancake.name)?String(pancake.name).trim():'';
}

function normalizedEntityStatus(value) {
  const raw=String(value||'').trim().toUpperCase();
  if(!raw)return {label:'',kind:''};
  if(raw==='ACTIVE')return {label:'Đang bật',kind:'on'};
  if(raw.includes('PAUSED')||raw==='INACTIVE'||raw==='DISABLED'||raw==='DELETED'||raw==='ARCHIVED')return {label:'Đã tắt',kind:'off'};
  if(raw==='PENDING_REVIEW'||raw==='IN_PROCESS')return {label:'Đang xét duyệt',kind:'pending'};
  if(raw==='DISAPPROVED'||raw==='WITH_ISSUES')return {label:'Có vấn đề',kind:'bad'};
  return {label:raw.replaceAll('_',' '),kind:'neutral'};
}

function entityStatusBadge(value) {
  const status=normalizedEntityStatus(value);
  return status.label?'<span class="entity-status '+status.kind+'">'+esc(status.label)+'</span>':'';
}

function entityNameCell(name,status,id) {
  const title=String(name||'').trim();
  const identifier=String(id||'').trim();
  if(!title&&!status&&!identifier)return '';
  return (title?'<b>'+esc(title)+'</b>':'')+entityStatusBadge(status)+(identifier?'<br><small>ID '+esc(identifier)+'</small>':'');
}

async function hydrateLeadEntityStatuses(leads) {
  const input=Array.isArray(leads)?leads:[];
  const ids=[...new Set(input.map(row=>String(row.adId||row.ad_id||'')).filter(Boolean))].sort();
  if(!ids.length)return input;
  if(!cache.leadEntityStatuses)cache.leadEntityStatuses=new Map();
  const cacheKey=ids.join(',');
  const hit=cache.leadEntityStatuses.get(cacheKey);
  let byAd=hit&&Date.now()-hit.time<300000?hit.data:null;
  if(!byAd){
    byAd=new Map();
    const token=process.env.META_ACCESS_TOKEN||process.env.META_USER_ACCESS_TOKEN||process.env.FACEBOOK_USER_ACCESS_TOKEN||process.env.USER_ACCESS_TOKEN||'';
    if(token){
      for(let offset=0;offset<ids.length;offset+=50){
        const batch=ids.slice(offset,offset+50);
        try{
          const fields='id,name,status,effective_status,campaign{id,name,status,effective_status},adset{id,name,status,effective_status}';
          const data=await fetchJson('https://graph.facebook.com/'+GRAPH_VERSION+'/?ids='+encodeURIComponent(batch.join(','))+'&fields='+encodeURIComponent(fields)+'&access_token='+encodeURIComponent(token));
          for(const [adId,item] of Object.entries(data||{})){
            if(!item||item.error)continue;
            byAd.set(String(adId),item);
          }
        }catch{}
      }
    }
    cache.leadEntityStatuses.set(cacheKey,{time:Date.now(),data:byAd});
  }
  return input.map(row=>{
    const adId=String(row.adId||row.ad_id||'');
    const item=byAd.get(adId)||{};
    const campaign=item.campaign||{};
    const adset=item.adset||{};
    return {
      ...row,
      campaignId:String(row.campaignId||row.campaign_id||campaign.id||''),
      campaignName:row.campaignName||row.campaign_name||campaign.name||'',
      campaignStatus:row.campaignStatus||row.campaign_status||campaign.effective_status||campaign.status||'',
      adsetId:String(row.adsetId||row.adset_id||adset.id||''),
      adsetName:row.adsetName||row.adset_name||adset.name||'',
      adsetStatus:row.adsetStatus||row.adset_status||adset.effective_status||adset.status||'',
      adName:row.adName||row.ad_name||item.name||'',
      adStatus:row.adStatus||row.ad_status||item.effective_status||item.status||row.effectiveStatus||row.effective_status||'',
    };
  });
}

async function leadsPage(req,res) {
  const p=period(req.query,'dashboard');
  const selected=String(req.query.account||'all')==='all'?'all':act(req.query.account);
  const report=await loadUnifiedLeadReport(p,selected);
  const accounts=report.accounts||[];
  const leads=await hydrateLeadEntityStatuses(report.leads||[]);
  const pancakeNames=pancakeLeadNameMap(report.pancake?.rows||[]);
  const groups=new Map();
  for(const lead of leads){
    const key=leadIdentity(lead)||('customer|'+String(lead.sender_id||lead.customer_id||lead.conversation_id||''));
    const displayName=resolvedLeadName(lead,pancakeNames);
    const group=groups.get(key)||{items:[],name:'',phones:new Set(),hasZalo:false,maxTime:0,customerKey:key};
    group.items.push(lead);
    if(!group.name&&displayName)group.name=displayName;
    for(const phone of lead.phones||[])if(phone)group.phones.add(String(phone));
    group.hasZalo=group.hasZalo||Boolean(lead.has_zalo);
    group.maxTime=Math.max(group.maxTime,new Date(lead.conversation_started_at||lead.referral_at||0).getTime()||0);
    groups.set(key,group);
  }
  const ordered=[...groups.values()].sort((a,b)=>b.maxTime-a.maxTime);
  let sequence=0;
  const rows=ordered.map(group=>{
    sequence++;
    group.items.sort((a,b)=>new Date(b.conversation_started_at||b.referral_at||0)-new Date(a.conversation_started_at||a.referral_at||0));
    const span=group.items.length;
    const contact=[...group.phones].join(', ')+(group.hasZalo?(group.phones.size?' · Zalo':'Zalo'):'');
    return group.items.map((x,index)=>{
      const fixed=index===0
        ? '<td rowspan="'+span+'" class="lead-group-cell lead-seq"><b>'+sequence+'</b></td>'
          +'<td rowspan="'+span+'" class="lead-group-cell lead-customer"><b>'+esc(group.name)+'</b><br><small>'+esc([x.sender_id||x.customer_id,x.page_name].filter(Boolean).join(' · '))+'</small></td>'
          +'<td rowspan="'+span+'" class="lead-group-cell lead-contact">'+esc(contact)+'</td>'
        : '';
      const tags=(x.tags||[]).map(tag=>'<span class="lead-tag">'+esc(tag)+'</span>').join(' ');
      return '<tr class="lead-ad-row" data-customer="'+esc(group.name)+'" data-customer-key="'+esc(group.customerKey)+'" data-contact="'+esc(contact)+'" data-account="'+esc(x.accountName||'')+'" data-ad="'+esc(x.adName||'')+'" data-product="'+esc(x.product||'')+'">'
        +fixed
        +'<td><b>'+esc(x.accountName||'')+'</b><br><small>'+esc(x.accountTimezone||'')+'</small></td>'
        +'<td>'+entityNameCell(x.campaignName,x.campaignStatus,x.campaignId)+'</td>'
        +'<td>'+entityNameCell(x.adsetName,x.adsetStatus,x.adsetId)+'</td>'
        +'<td>'+entityNameCell(x.adName,x.adStatus,x.adId||x.ad_id)+'</td>'
        +'<td>'+esc(x.product||'')+'</td>'
        +'<td>'+esc(x.source_type||'')+'</td>'
        +'<td class="tags">'+tags+'</td>'
        +'<td>'+esc(x.snippet||'')+'</td>'
        +'<td>'+esc(formatAccountLeadTime(x))+'</td>'
        +'</tr>';
    }).join('');
  }).join('');
  const contactCount=ordered.filter(group=>group.phones.size||group.hasZalo).length;
  const accountCount=new Set(leads.map(row=>act(row.accountId)).filter(Boolean)).size;
  const errors=[...(report.referrals?.error?[report.referrals.error]:[]),...(report.pancake?.error?[report.pancake.error]:[])];
  const exportBar='<div class="export-actions"><a class="btn green" href="/export?type=leads&format=xlsx&from='+encodeURIComponent(p.since)+'&to='+encodeURIComponent(p.until)+'&account='+encodeURIComponent(selected)+'">Xuất Excel</a><a class="btn" href="/export?type=leads&format=csv&from='+encodeURIComponent(p.since)+'&to='+encodeURIComponent(p.until)+'&account='+encodeURIComponent(selected)+'">Xuất CSV</a></div>';
  const body='<div class="top"><div><h1>Khách hàng / Lead</h1><div>Tra cứu từng khách, nguồn quảng cáo và trạng thái Campaign · Ad set · QC · '+esc(p.since)+' → '+esc(p.until)+'</div></div>'+exportBar+'</div>'
    +filterForm(p,accounts,selected)
    +(errors.length?'<div class="notice error">'+errors.map(esc).join('<br>')+'</div>':'')
    +'<div class="stats"><div class="stat">Khách đã đối chiếu<b>'+ordered.length+'</b></div><div class="stat">Có SĐT/Zalo<b>'+contactCount+'</b></div><div class="stat">Tài khoản có khách<b>'+accountCount+'</b></div></div>'
    +'<div class="card table"><table class="aiguka-data-table lead-report-table" data-customer-count="'+ordered.length+'"><thead><tr><th>#</th><th>Khách hàng</th><th>SĐT/Zalo</th><th>Tài khoản QC</th><th>Campaign</th><th>Ad set</th><th>Quảng cáo</th><th>Sản phẩm</th><th>Nguồn khách</th><th>Tag Pancake</th><th>Tin cuối</th><th>Giờ tài khoản</th></tr></thead><tbody>'+(rows||'<tr><td colspan="12">Không có khách quảng cáo đã đối chiếu được trong khoảng ngày đã chọn.</td></tr>')+'</tbody></table></div>';
  res.type('html').send(layout('Khách hàng Lead',body,'leads'));
}

async function adPerformancePage(req,res) {
  const p=period(req.query,'dashboard');
  const selected=String(req.query.account||'all')==='all'?'all':act(req.query.account);
  const report=await loadUnifiedLeadReport(p,selected);
  const accounts=report.accounts||[];
  const performance=buildMetaAdPerformance(report);
  const rows=performance.rows.map((x,index)=>'<tr class="meta-ad-performance-row" data-account="'+esc(x.accountName||'')+'" data-ad="'+esc(x.adName||'')+'">'
    +'<td>'+(index+1)+'</td>'
    +'<td><b>'+esc(x.accountName||'')+'</b><br><small>'+esc(x.accountId||'')+'</small></td>'
    +'<td>'+esc(x.campaignName||'')+'</td>'
    +'<td>'+esc(x.adsetName||'')+'</td>'
    +'<td><b>'+esc(x.adName||'')+'</b><br><small>ID '+esc(x.adId||'')+'</small></td>'
    +'<td>'+entityStatusBadge(x.effectiveStatus)+'</td>'
    +'<td>'+money(x.spend)+'</td>'
    +'<td><b>'+Number(x.metaCustomers||0)+'</b></td>'
    +'<td>'+Number(x.matchedCount||0)+'</td>'
    +'<td class="'+(x.unmatchedCount?'warn':'')+'"><b>'+Number(x.unmatchedCount||0)+'</b></td>'
    +'</tr>').join('');
  const accountCount=new Set(performance.rows.map(row=>act(row.accountId)).filter(Boolean)).size;
  const errors=[...(report.meta?.errors||[]),...(report.creativeErrors||[])];
  const discrepancy=performance.unmatchedCustomers
    ? '<div class="notice"><b>Meta ghi nhận '+performance.metaCustomers+' khách theo QC.</b> Đã nối được danh tính '+performance.matchedCustomers+' khách; còn '+performance.unmatchedCustomers+' khách chưa nối được tên. Tổng hiệu quả vẫn giữ theo Meta.</div>'
    : '';
  const body='<div class="top"><div><h1>Hiệu quả quảng cáo</h1><div>Meta Ads Insights + attribution lịch sử · tính cả QC, Ad set, Campaign và bài viết đã tắt · '+esc(p.since)+' → '+esc(p.until)+'</div></div></div>'
    +filterForm(p,accounts,selected)
    +(errors.length?'<div class="notice error">'+errors.map(esc).join('<br>')+'</div>':'')+discrepancy
    +'<div class="stats"><div class="stat">Khách Meta theo QC<b>'+performance.metaCustomers+'</b></div><div class="stat">Đã nối danh tính<b>'+performance.matchedCustomers+'</b></div><div class="stat">Chưa nối danh tính<b>'+performance.unmatchedCustomers+'</b></div><div class="stat">QC có khách<b>'+performance.adsWithCustomers+'</b></div><div class="stat">Tài khoản có khách<b>'+accountCount+'</b></div></div>'
    +'<div class="card table"><table class="aiguka-data-table meta-ad-performance-table"><thead><tr><th>#</th><th>Tài khoản QC</th><th>Campaign</th><th>Ad set</th><th>Quảng cáo</th><th>Trạng thái</th><th>Chi tiêu</th><th>Khách Meta</th><th>Đã nối tên</th><th>Chưa nối tên</th></tr></thead><tbody>'+(rows||'<tr><td colspan="10">Meta chưa trả dữ liệu quảng cáo trong khoảng ngày đã chọn.</td></tr>')+'</tbody></table></div>';
  res.type('html').send(layout('Hiệu quả quảng cáo',body,'ad-performance'));
}

`;

  source = source.slice(0, pageStart) + pages + source.slice(installStart);

  const navAnchor = "${nav('/leads','☏ Khách hàng / Lead','leads')}";
  const performanceNav = "${nav('/ad-performance','◎ Hiệu quả quảng cáo','ad-performance')}";
  if (!source.includes(navAnchor)) throw new Error("SPLIT_LEADS_NAV_ANCHOR_NOT_FOUND");
  source = source.replace(navAnchor, navAnchor + performanceNav);

  const customersRouteStart = source.indexOf("  app.get('/customers'");
  if (customersRouteStart < 0) throw new Error("SPLIT_LEADS_ROUTE_ANCHOR_NOT_FOUND");
  const customersRouteEnd = source.indexOf("\n", customersRouteStart);
  const performanceRoutes = "\n  app.get('/ad-performance',(req,res)=>adPerformancePage(req,res).catch(e=>res.status(500).send(layout('Lỗi',`<div class=\\\"notice error\\\">${esc(e.message)}</div>`))));\n  app.get('/ad-report',(req,res)=>adPerformancePage(req,res).catch(e=>res.status(500).send(layout('Lỗi',`<div class=\\\"notice error\\\">${esc(e.message)}</div>`))));";
  source = source.slice(0, customersRouteEnd) + performanceRoutes + source.slice(customersRouteEnd);

  const css = ".entity-status{display:inline-block;margin-left:6px;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:700;white-space:nowrap;vertical-align:1px}.entity-status.on{background:#dcfce7;color:#166534;border:1px solid #86efac}.entity-status.off{background:#f1f5f9;color:#475569;border:1px solid #cbd5e1}.entity-status.pending{background:#fef3c7;color:#92400e;border:1px solid #fcd34d}.entity-status.bad{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5}.entity-status.neutral{background:#e0e7ff;color:#3730a3;border:1px solid #a5b4fc}";
  if (!source.includes(".entity-status{")) {
    if (!source.includes("#tap{")) throw new Error("SPLIT_LEADS_CSS_ANCHOR_NOT_FOUND");
    source = source.replace("#tap{", css + "#tap{");
  }

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`SPLIT_LEADS_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Customer leads and ad performance are separate menu pages");
}
