import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_LEAD_META_INSIGHTS_TRUTH_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Lead Meta Insights truth V1 already installed");
} else {
  const pageStart = source.indexOf("async function leadsPage(req,res)");
  const installStart = source.indexOf("export function installStableV7Dashboard", pageStart);
  if (pageStart < 0 || installStart < 0) {
    throw new Error("LEAD_META_INSIGHTS_PAGE_ANCHOR_NOT_FOUND");
  }

  const page = String.raw`// AIGUKA_LEAD_META_INSIGHTS_TRUTH_V1
function buildMetaAdPerformance(report) {
  const leadRows = Array.isArray(report?.leads) ? report.leads : [];
  const insightRows = Array.isArray(report?.meta?.rows) ? report.meta.rows : [];
  const groups = new Map();
  const keyOf = row => [act(row.accountId || row.ad_account_id || ""), String(row.adId || row.ad_id || "UNMAPPED")].join("|");
  const ensure = row => {
    const key = keyOf(row);
    let item = groups.get(key);
    if (!item) {
      item = {
        key,
        accountId: act(row.accountId || row.ad_account_id || ""),
        accountName: row.accountName || row.ad_account_name || "Chưa xác định tài khoản",
        campaignName: row.campaignName || row.campaign_name || "",
        adsetName: row.adsetName || row.adset_name || "",
        adId: String(row.adId || row.ad_id || ""),
        adName: row.adName || row.ad_name || "Chưa xác định QC",
        effectiveStatus: row.effectiveStatus || row.effective_status || row.status || "",
        spend: 0,
        metaCustomers: 0,
        matchedCustomers: new Set(),
      };
      groups.set(key, item);
    }
    if (!item.accountName && (row.accountName || row.ad_account_name)) item.accountName = row.accountName || row.ad_account_name;
    if (!item.campaignName && (row.campaignName || row.campaign_name)) item.campaignName = row.campaignName || row.campaign_name;
    if (!item.adsetName && (row.adsetName || row.adset_name)) item.adsetName = row.adsetName || row.adset_name;
    if ((!item.adName || item.adName === "Chưa xác định QC") && (row.adName || row.ad_name)) item.adName = row.adName || row.ad_name;
    if (!item.effectiveStatus && (row.effectiveStatus || row.effective_status || row.status)) item.effectiveStatus = row.effectiveStatus || row.effective_status || row.status;
    return item;
  };

  for (const row of insightRows) {
    const item = ensure(row);
    item.spend += Number(row.spend || row.spend_with_tax || 0);
    item.metaCustomers += Number(
      row.messages ??
      row.metaConversations ??
      row.meta_conversations ??
      row.messagingConversationsStarted ??
      row.messaging_conversations_started ??
      row.conversations ??
      0
    );
  }

  for (const lead of leadRows) {
    const item = ensure(lead);
    const customerKey = leadIdentity(lead) || String(lead.sender_id || lead.customer_id || lead.name || "");
    if (customerKey) item.matchedCustomers.add(customerKey);
  }

  const rows = [...groups.values()].map(item => ({
    ...item,
    metaCustomers: Math.max(0, Number(item.metaCustomers || 0)),
    matchedCount: item.matchedCustomers.size,
    unmatchedCount: Math.max(Number(item.metaCustomers || 0) - item.matchedCustomers.size, 0),
  })).filter(item => item.metaCustomers > 0 || item.matchedCount > 0 || item.spend > 0)
    .sort((a, b) => b.metaCustomers - a.metaCustomers || b.spend - a.spend || String(a.adName).localeCompare(String(b.adName), "vi"));

  return {
    rows,
    metaCustomers: rows.reduce((sum, item) => sum + item.metaCustomers, 0),
    matchedCustomers: rows.reduce((sum, item) => sum + item.matchedCount, 0),
    unmatchedCustomers: rows.reduce((sum, item) => sum + item.unmatchedCount, 0),
    adsWithCustomers: rows.filter(item => item.metaCustomers > 0 || item.matchedCount > 0).length,
  };
}

async function leadsPage(req,res) {
  const p=period(req.query,"dashboard");
  const selected=String(req.query.account||"all")==="all"?"all":act(req.query.account);
  const report=await loadUnifiedLeadReport(p,selected);
  const accounts=report.accounts||[],leads=report.leads||[];
  const performance=buildMetaAdPerformance(report);
  const groups=new Map();
  for(const lead of leads){
    const key=leadIdentity(lead)||("customer|"+String(lead.name||lead.customer_id||""));
    const group=groups.get(key)||{items:[],name:lead.name||"Khách hàng",phones:new Set(),hasZalo:false,maxTime:0,customerKey:key};
    group.items.push(lead);
    for(const phone of lead.phones||[])if(phone)group.phones.add(String(phone));
    group.hasZalo=group.hasZalo||Boolean(lead.has_zalo);
    group.maxTime=Math.max(group.maxTime,new Date(lead.conversation_started_at||lead.referral_at||0).getTime()||0);
    groups.set(key,group);
  }
  const ordered=[...groups.values()].sort((a,b)=>b.maxTime-a.maxTime);
  let sequence=0;
  const detailRows=ordered.map(group=>{
    sequence++;
    group.items.sort((a,b)=>new Date(b.conversation_started_at||b.referral_at||0)-new Date(a.conversation_started_at||a.referral_at||0));
    const span=group.items.length;
    const contact=[...group.phones].join(", ")+(group.hasZalo?(group.phones.size?" · Zalo":"Zalo"):"");
    return group.items.map((x,index)=>{
      const fixed=index===0
        ? '<td rowspan="'+span+'" class="lead-group-cell lead-seq"><b>'+sequence+'</b></td>'
          +'<td rowspan="'+span+'" class="lead-group-cell lead-customer"><b>'+esc(group.name)+'</b><br><small>'+esc([x.sender_id||x.customer_id,x.page_name].filter(Boolean).join(" · "))+'</small></td>'
          +'<td rowspan="'+span+'" class="lead-group-cell lead-contact">'+esc(contact)+'</td>'
        : '';
      const tags=(x.tags||[]).map(tag=>'<span class="lead-tag">'+esc(tag)+'</span>').join(' ');
      return '<tr class="lead-ad-row" data-customer="'+esc(group.name)+'" data-customer-key="'+esc(group.customerKey)+'" data-contact="'+esc(contact)+'" data-account="'+esc(x.accountName||'')+'" data-ad="'+esc(x.adName||'')+'" data-product="'+esc(x.product||'')+'">'
        +fixed
        +'<td><b>'+esc(x.accountName||"Chưa xác định")+'</b><br><small>'+esc(x.accountTimezone||"")+'</small></td>'
        +'<td>'+esc(x.campaignName||"")+'</td>'
        +'<td>'+esc(x.adsetName||"")+'</td>'
        +'<td><b>'+esc(x.adName||"")+'</b><br><small>ID '+esc(x.adId||x.ad_id||"")+'</small></td>'
        +'<td>'+esc(x.product||"Khác")+'</td>'
        +'<td>'+esc(x.source_type||"Meta Business")+'</td>'
        +'<td class="tags">'+tags+'</td>'
        +'<td>'+esc(x.snippet||"")+'</td>'
        +'<td>'+esc(formatAccountLeadTime(x))+'</td>'
        +'</tr>';
    }).join('');
  }).join('');

  const performanceRows=performance.rows.map((x,index)=>{
    const status=x.effectiveStatus||'Không lọc theo trạng thái';
    return '<tr class="meta-ad-performance-row" data-account="'+esc(x.accountName||'')+'" data-ad="'+esc(x.adName||'')+'">'
      +'<td>'+(index+1)+'</td>'
      +'<td><b>'+esc(x.accountName||'')+'</b><br><small>'+esc(x.accountId||'')+'</small></td>'
      +'<td>'+esc(x.campaignName||'')+'</td>'
      +'<td>'+esc(x.adsetName||'')+'</td>'
      +'<td><b>'+esc(x.adName||'Chưa xác định QC')+'</b><br><small>ID '+esc(x.adId||'')+'</small></td>'
      +'<td>'+esc(status)+'</td>'
      +'<td>'+money(x.spend)+'</td>'
      +'<td><b>'+Number(x.metaCustomers||0)+'</b></td>'
      +'<td>'+Number(x.matchedCount||0)+'</td>'
      +'<td class="'+(x.unmatchedCount?'warn':'')+'"><b>'+Number(x.unmatchedCount||0)+'</b></td>'
      +'</tr>';
  }).join('');

  const contactCount=ordered.filter(x=>x.phones.size||x.hasZalo).length;
  const accountCount=new Set(performance.rows.map(x=>act(x.accountId)).filter(Boolean)).size;
  const errors=[...(report.meta?.errors||[]),...(report.referrals?.error?[report.referrals.error]:[]),...(report.pancake?.error?[report.pancake.error]:[])];
  const discrepancy=performance.unmatchedCustomers
    ? '<div class="notice"><b>Meta ghi nhận '+performance.metaCustomers+' khách theo QC.</b> Hệ thống đã nối được danh tính '+performance.matchedCustomers+' khách; còn '+performance.unmatchedCustomers+' khách Meta chưa trả đủ referral/danh tính. Số khách hiệu quả quảng cáo vẫn giữ theo Meta, không bị giảm theo số tên đã nối.</div>'
    : '';
  const exportBar='<div class="export-actions"><a class="btn green" href="/export?type=leads&format=xlsx&from='+encodeURIComponent(p.since)+'&to='+encodeURIComponent(p.until)+'&account='+encodeURIComponent(selected)+'">Xuất Excel</a><a class="btn" href="/export?type=leads&format=csv&from='+encodeURIComponent(p.since)+'&to='+encodeURIComponent(p.until)+'&account='+encodeURIComponent(selected)+'">Xuất CSV</a></div>';
  const body='<div class="top"><div><h1>Khách hàng / Lead</h1><div>Số khách hiệu quả lấy trực tiếp theo tài khoản QC và từng quảng cáo từ Meta Ads Insights · không phụ thuộc Page · không loại QC/bài viết đã tắt · '+esc(p.since)+' → '+esc(p.until)+'</div></div>'+exportBar+'</div>'
    +filterForm(p,accounts,selected)
    +(errors.length?'<div class="notice error">'+errors.map(esc).join('<br>')+'</div>':'')+discrepancy
    +'<div class="stats"><div class="stat">Khách Meta theo QC<b>'+performance.metaCustomers+'</b></div><div class="stat">Đã nối danh tính<b>'+performance.matchedCustomers+'</b></div><div class="stat">Chưa nối danh tính<b>'+performance.unmatchedCustomers+'</b></div><div class="stat">QC có khách<b>'+performance.adsWithCustomers+'</b></div><div class="stat">Tài khoản có khách<b>'+accountCount+'</b></div></div>'
    +'<div class="card table"><h2 style="margin:0 0 10px">Hiệu quả theo quảng cáo — nguồn Meta</h2><table class="aiguka-data-table meta-ad-performance-table"><thead><tr><th>#</th><th>Tài khoản QC</th><th>Campaign</th><th>Ad set</th><th>Quảng cáo</th><th>Trạng thái</th><th>Chi tiêu</th><th>Khách Meta</th><th>Đã nối tên</th><th>Chưa nối tên</th></tr></thead><tbody>'+(performanceRows||'<tr><td colspan="10">Meta chưa trả dữ liệu quảng cáo trong khoảng ngày đã chọn.</td></tr>')+'</tbody></table></div>'
    +'<div class="card table"><h2 style="margin:0 0 10px">Danh tính khách đã đối chiếu được</h2><table class="aiguka-data-table lead-report-table" data-meta-messages="'+performance.metaCustomers+'" data-customer-count="'+ordered.length+'"><thead><tr><th>#</th><th>Khách hàng <span class="lead-head-count customers">Khách '+ordered.length+'</span></th><th>SĐT/Zalo <span class="lead-head-count contacts">Có '+contactCount+'</span></th><th>Tài khoản QC</th><th>Campaign</th><th>Ad set</th><th>Quảng cáo</th><th>Sản phẩm</th><th>Nguồn khách</th><th>Tag Pancake</th><th>Tin cuối</th><th>Giờ tài khoản</th></tr></thead><tbody>'+(detailRows||'<tr><td colspan="12">Chưa nối được danh tính khách với QC trong khoảng ngày đã chọn.</td></tr>')+'</tbody></table></div>';
  res.type("html").send(layout("Khách hàng Lead",body,"leads"));
}

`;

  source = source.slice(0, pageStart) + page + source.slice(installStart);
  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`LEAD_META_INSIGHTS_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Lead report now uses Meta Ads Insights as count truth, including paused/old ads");
}
