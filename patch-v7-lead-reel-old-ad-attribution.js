import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_LEAD_REEL_OLD_AD_ATTRIBUTION_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Reel and old-ad attribution V1 already installed");
} else {
  if (!source.includes("AIGUKA_LEAD_META_INSIGHTS_TRUTH_V1")) {
    throw new Error("REEL_ATTRIBUTION_REQUIRES_META_INSIGHTS_TRUTH");
  }

  const loaderStart = source.indexOf('async function loadUnifiedLeadReport(p, selected = "all") {');
  const buildStart = source.indexOf("function buildMetaAdPerformance(report) {", loaderStart);
  if (loaderStart < 0 || buildStart < 0) throw new Error("REEL_ATTRIBUTION_LOADER_ANCHOR_NOT_FOUND");

  const helpersAndLoader = String.raw`// AIGUKA_LEAD_REEL_OLD_AD_ATTRIBUTION_V1
async function fetchLeadRestRows(table, select, filters = [], order = "") {
  if (!META_LEADS_SUPABASE_URL || !META_LEADS_SUPABASE_KEY) return [];
  const rows = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const params = new URLSearchParams();
    params.set("select", select);
    for (const [key, value] of filters) params.append(key, value);
    if (order) params.set("order", order);
    params.set("limit", "1000");
    params.set("offset", String(offset));
    const response = await fetch(META_LEADS_SUPABASE_URL + "/rest/v1/" + table + "?" + params.toString(), {
      headers: { apikey: META_LEADS_SUPABASE_KEY, authorization: "Bearer " + META_LEADS_SUPABASE_KEY },
      signal: AbortSignal.timeout(30000),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => []);
    if (!response.ok || !Array.isArray(payload)) throw new Error(payload?.message || payload?.error || ("SUPABASE_" + table + "_" + response.status));
    rows.push(...payload);
    if (payload.length < 1000) break;
  }
  return rows;
}

async function fetchRecoveredCommentLeadOrigins(since, until) {
  if (!cache.recoveredCommentLeadOrigins) cache.recoveredCommentLeadOrigins = new Map();
  const key = String(since) + ":" + String(until);
  const hit = cache.recoveredCommentLeadOrigins.get(key);
  if (hit && Date.now() - hit.time < 60000) return hit.data;
  const startIso = shiftLeadDate(since, -2) + "T00:00:00Z";
  const endIso = shiftLeadDate(until, 3) + "T00:00:00Z";
  const result = { rows: [], error: null };
  try {
    const [comments, starts] = await Promise.all([
      fetchLeadRestRows(
        "v8_comment_events",
        "page_id,sender_id,sender_name,customer_id,event_time,post_id,comment_id,detected_phone,has_contact,private_reply_status",
        [["event_time", "gte." + startIso], ["event_time", "lt." + endIso], ["post_id", "not.is.null"]],
        "event_time.desc"
      ),
      fetchLeadRestRows(
        "v8_meta_conversation_starts",
        "page_id,page_name,sender_id,customer_id,conversation_id,customer_name,phone,zalo,tags,lead_score,product_key,conversation_started_at,last_message_at,last_message_text,has_phone,has_zalo",
        [["conversation_started_at", "gte." + startIso], ["conversation_started_at", "lt." + endIso]],
        "conversation_started_at.desc"
      ),
    ]);
    const latestStart = new Map();
    for (const row of starts) {
      const identity = String(row.page_id || "") + "|" + String(row.sender_id || "");
      if (!latestStart.has(identity)) latestStart.set(identity, row);
    }
    const seen = new Set();
    for (const comment of comments) {
      const pageId = String(comment.page_id || ""), senderId = String(comment.sender_id || ""), postId = String(comment.post_id || "");
      if (!pageId || !senderId || !postId) continue;
      const unique = pageId + "|" + senderId + "|" + postId;
      if (seen.has(unique)) continue;
      seen.add(unique);
      const start = latestStart.get(pageId + "|" + senderId) || {};
      const phones = [...new Set([comment.detected_phone, start.phone].filter(Boolean).map(String))];
      result.rows.push({
        name: start.customer_name || comment.sender_name || ("Khách ..." + senderId.slice(-6)),
        customer_id: senderId,
        sender_id: senderId,
        page_id: pageId,
        page_name: start.page_name || "",
        conversation_id: String(start.conversation_id || senderId),
        source_type: "Meta comment",
        conversation_started_at: start.conversation_started_at || comment.event_time,
        referral_at: comment.event_time,
        updated_at: start.last_message_at || comment.event_time,
        last_customer_message_at: start.last_message_at || comment.event_time,
        message_count: 1,
        has_phone: Boolean(comment.has_contact || start.has_phone || phones.length),
        has_zalo: Boolean(start.has_zalo || start.zalo),
        phones,
        product: start.product_key || "",
        hot_lead: Number(start.lead_score || 0) >= 60,
        tags: Array.from(new Set([...(Array.isArray(start.tags) ? start.tags : []), ...(phones.length ? ["Có SĐT"] : [])])),
        snippet: start.last_message_text || "Khách đến từ bình luận bài quảng cáo",
        adId: "",
        adName: "",
        postId,
        commentId: String(comment.comment_id || ""),
        referralSource: "COMMENT_NOTICE",
        isAdConversation: true,
      });
    }
  } catch (error) {
    result.error = error.message;
  }
  cache.recoveredCommentLeadOrigins.set(key, { time: Date.now(), data: result });
  return result;
}

function collectCreativePostKeys(value, keyName = "", output = new Set()) {
  if (value === null || value === undefined) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectCreativePostKeys(item, keyName, output);
    return output;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) collectCreativePostKeys(item, key, output);
    return output;
  }
  const text = String(value || "").trim();
  if (!text) return output;
  const normalizedKey = String(keyName || "").toLowerCase();
  if (["effective_object_story_id", "object_story_id", "post_id", "video_id", "source_instagram_media_id"].includes(normalizedKey)) {
    output.add(text);
    if (text.includes("_")) output.add(text.split("_").pop());
  }
  for (const pattern of [/story_fbid=([0-9]+)/i, /\/reel\/([0-9]+)/i, /\/posts\/([0-9]+)/i, /\/videos\/([0-9]+)/i]) {
    const match = text.match(pattern);
    if (match?.[1]) output.add(match[1]);
  }
  return output;
}

async function fetchCreativeAdIndex(accounts, selected, pageIds = []) {
  if (!cache.allAdCreativeIndex) cache.allAdCreativeIndex = new Map();
  const token = process.env.META_ACCESS_TOKEN || process.env.META_USER_ACCESS_TOKEN || process.env.FACEBOOK_USER_ACCESS_TOKEN || process.env.USER_ACCESS_TOKEN || "";
  const empty = { byPost: new Map(), errors: [], adsScanned: 0 };
  if (!token) return { ...empty, errors: ["Thiếu Meta Ads OAuth token để đối chiếu bài viết/Reel với QC"] };

  let linkedIds = new Set();
  if (selected === "all" && pageIds.length) {
    try {
      const links = await fetchLeadRestRows("v8_meta_page_ad_accounts", "page_id,ad_account_id", [], "page_id.asc");
      const wantedPages = new Set(pageIds.map(String));
      linkedIds = new Set(links.filter(row => wantedPages.has(String(row.page_id || ""))).map(row => act(row.ad_account_id || "")).filter(Boolean));
    } catch {}
  }
  const candidates = (accounts || []).filter(account => {
    if (selected !== "all") return act(account.id) === act(selected);
    return linkedIds.size ? linkedIds.has(act(account.id)) : true;
  });
  const cacheKey = candidates.map(account => act(account.id)).sort().join(",");
  const hit = cache.allAdCreativeIndex.get(cacheKey);
  if (hit && Date.now() - hit.time < 15 * 60 * 1000) return hit.data;

  const byPost = new Map(), errors = [];
  let adsScanned = 0;
  for (const account of candidates) {
    let ads = null, lastError = null;
    for (let attempt = 1; attempt <= 2 && !ads; attempt++) {
      try {
        const fields = "id,name,status,effective_status,account_id,campaign{id,name},adset{id,name},creative{id,name,effective_object_story_id,object_story_id,object_story_spec,asset_feed_spec}";
        const url = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + act(account.id) + "/ads?fields=" + encodeURIComponent(fields) + "&limit=200&access_token=" + encodeURIComponent(token);
        ads = await pages(url, 40);
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    if (!ads) {
      errors.push((account.name || account.id) + " (" + String(account.id || "").replace(/^act_/, "") + "): " + (lastError?.message || "fetch failed"));
      continue;
    }
    adsScanned += ads.length;
    for (const item of ads) {
      const creative = item?.creative || {};
      const keys = [...collectCreativePostKeys(creative)];
      if (!keys.length) continue;
      const ad = {
        adId: String(item.id || ""),
        adName: item.name || "",
        accountId: act(item.account_id || account.id),
        accountName: account.name || item.account_id || "",
        campaignId: item?.campaign?.id || "",
        campaignName: item?.campaign?.name || "",
        adsetId: item?.adset?.id || "",
        adsetName: item?.adset?.name || "",
        effectiveStatus: item.effective_status || item.status || "",
        account,
      };
      for (const key of keys) {
        const normalized = String(key || "");
        if (!normalized) continue;
        const current = byPost.get(normalized) || [];
        if (!current.some(candidate => candidate.adId === ad.adId)) current.push(ad);
        byPost.set(normalized, current);
      }
    }
  }
  const data = { byPost, errors, adsScanned };
  cache.allAdCreativeIndex.set(cacheKey, { time: Date.now(), data });
  return data;
}

async function loadUnifiedLeadReport(p, selected = "all") {
  const [accounts, meta, pancake, referrals, commentOrigins] = await Promise.all([
    getAccounts(),
    fetchAds(p.since, p.until, selected),
    fetchPancake(3000),
    fetchMetaAdReferralEntries(p.since, p.until),
    fetchRecoveredCommentLeadOrigins(p.since, p.until),
  ]);
  const directCandidates = (referrals.rows || []).filter(row => row.isAdConversation && row.adId);
  const adMap = await resolveLeadAdMap(directCandidates, meta.rows || [], accounts);
  const commentRows = commentOrigins.rows || [];
  const creativeIndex = commentRows.length
    ? await fetchCreativeAdIndex(accounts, selected, [...new Set(commentRows.map(row => String(row.page_id || "")).filter(Boolean))])
    : { byPost: new Map(), errors: [], adsScanned: 0 };

  const paid = [], unresolved = [], seen = new Set();
  for (const row of [...directCandidates, ...commentRows]) {
    const identity = leadIdentity(row);
    if (!identity) continue;
    let matches = [];
    if (row.adId) {
      const direct = adMap.get(String(row.adId || ""));
      if (direct) matches = [direct];
    } else if (row.postId) {
      const full = String(row.postId || ""), tail = full.includes("_") ? full.split("_").pop() : full;
      matches = creativeIndex.byPost.get(full) || creativeIndex.byPost.get(tail) || [];
    }
    if (matches.length !== 1 || !matches[0]?.accountId) {
      unresolved.push({ ...row, matchCount: matches.length });
      continue;
    }
    const ad = matches[0];
    const account = ad.account || (accounts || []).find(item => act(item.id) === act(ad.accountId)) || null;
    const lead = {
      ...row,
      adId: String(ad.adId || row.adId || ""),
      accountId: act(ad.accountId),
      accountName: ad.accountName || account?.name || ad.accountId,
      accountTimezone: account?.timezoneName || account?.timezone_name || "Asia/Ho_Chi_Minh",
      campaignName: ad.campaignName || "",
      adsetName: ad.adsetName || "",
      adName: ad.adName || row.adName || "",
      effectiveStatus: ad.effectiveStatus || "",
    };
    const localDate = accountLeadDate(lead);
    if (!localDate || localDate < p.since || localDate > p.until) continue;
    if (selected !== "all" && act(lead.accountId) !== act(selected)) continue;
    const rowIdentity = identity + "|ad:" + String(lead.adId || "");
    if (seen.has(rowIdentity)) continue;
    seen.add(rowIdentity);
    paid.push(lead);
  }
  const leads = enrichMetaLeadsWithPancake(paid, pancake.rows || []);
  leads.sort((left, right) => new Date(right.conversation_started_at || 0) - new Date(left.conversation_started_at || 0));
  return {
    accounts,
    meta,
    pancake,
    referrals,
    commentOrigins,
    creativeErrors: creativeIndex.errors || [],
    adsScannedForHistory: Number(creativeIndex.adsScanned || 0),
    leads,
    unresolved,
    unresolvedCount: unresolved.length,
  };
}

`;

  source = source.slice(0, loaderStart) + helpersAndLoader + source.slice(buildStart);

  const nextBuildStart = source.indexOf("function buildMetaAdPerformance(report) {");
  const pageStart = source.indexOf("async function leadsPage(req,res)", nextBuildStart);
  if (nextBuildStart < 0 || pageStart < 0) throw new Error("REEL_ATTRIBUTION_BUILD_ANCHOR_NOT_FOUND");

  const performanceBuilder = String.raw`function buildMetaAdPerformance(report) {
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
    item.spend += Number(row.spend ?? row.spend_with_tax ?? 0);
    item.metaCustomers += Number(
      row.messages ?? row.metaConversations ?? row.meta_conversations ?? row.messagingConversationsStarted ?? row.messaging_conversations_started ?? row.conversations ?? 0
    );
  }
  for (const lead of leadRows) {
    const item = ensure(lead);
    const customerKey = leadIdentity(lead) || String(lead.sender_id || lead.customer_id || lead.name || "");
    if (customerKey) item.matchedCustomers.add(customerKey);
  }
  const rows = [...groups.values()].map(item => {
    const matchedCount = item.matchedCustomers.size;
    const metaCustomers = Math.max(0, Number(item.metaCustomers || 0));
    return {
      ...item,
      metaCustomers,
      matchedCount,
      effectiveCustomers: Math.max(metaCustomers, matchedCount),
      unmatchedCount: Math.max(metaCustomers - matchedCount, 0),
    };
  }).filter(item => item.effectiveCustomers > 0 || item.spend > 0)
    .sort((a, b) => b.effectiveCustomers - a.effectiveCustomers || b.spend - a.spend || String(a.adName).localeCompare(String(b.adName), "vi"));
  return {
    rows,
    effectiveCustomers: rows.reduce((sum, item) => sum + item.effectiveCustomers, 0),
    metaCustomers: rows.reduce((sum, item) => sum + item.metaCustomers, 0),
    matchedCustomers: rows.reduce((sum, item) => sum + item.matchedCount, 0),
    unmatchedCustomers: rows.reduce((sum, item) => sum + item.unmatchedCount, 0),
    adsWithCustomers: rows.filter(item => item.effectiveCustomers > 0).length,
  };
}

`;
  source = source.slice(0, nextBuildStart) + performanceBuilder + source.slice(pageStart);

  const nextPageStart = source.indexOf("async function leadsPage(req,res)");
  const installStart = source.indexOf("export function installStableV7Dashboard", nextPageStart);
  if (nextPageStart < 0 || installStart < 0) throw new Error("REEL_ATTRIBUTION_PAGE_ANCHOR_NOT_FOUND");

  const page = String.raw`async function leadsPage(req,res) {
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
    const status=x.effectiveStatus||'Không xác định';
    return '<tr class="meta-ad-performance-row" data-account="'+esc(x.accountName||'')+'" data-ad="'+esc(x.adName||'')+'">'
      +'<td>'+(index+1)+'</td>'
      +'<td><b>'+esc(x.accountName||'')+'</b><br><small>'+esc(x.accountId||'')+'</small></td>'
      +'<td>'+esc(x.campaignName||'')+'</td>'
      +'<td>'+esc(x.adsetName||'')+'</td>'
      +'<td><b>'+esc(x.adName||'Chưa xác định QC')+'</b><br><small>ID '+esc(x.adId||'')+'</small></td>'
      +'<td>'+esc(status)+'</td>'
      +'<td>'+money(x.spend)+'</td>'
      +'<td>'+Number(x.metaCustomers||0)+'</td>'
      +'<td>'+Number(x.matchedCount||0)+'</td>'
      +'<td><b>'+Number(x.effectiveCustomers||0)+'</b></td>'
      +'<td class="'+(x.unmatchedCount?'warn':'')+'"><b>'+Number(x.unmatchedCount||0)+'</b></td>'
      +'</tr>';
  }).join('');

  const contactCount=ordered.filter(x=>x.phones.size||x.hasZalo).length;
  const accountCount=new Set(performance.rows.map(x=>act(x.accountId)).filter(Boolean)).size;
  const decorateError=value=>{
    const text=String(value||'');
    const account=accounts.find(item=>text.startsWith(String(item.name||'')+':'));
    return account?String(account.name)+' ('+String(account.id||'').replace(/^act_/,'')+'):'+text.slice(String(account.name||'').length+1):text;
  };
  const errors=[...(report.meta?.errors||[]),...(report.referrals?.error?[report.referrals.error]:[]),...(report.commentOrigins?.error?[report.commentOrigins.error]:[]),...(report.creativeErrors||[]),...(report.pancake?.error?[report.pancake.error]:[])].map(decorateError);
  const discrepancy=performance.unmatchedCustomers
    ? '<div class="notice"><b>Meta ghi nhận '+performance.metaCustomers+' khách mới theo QC.</b> Đã nối được '+performance.matchedCustomers+' danh tính; còn '+performance.unmatchedCustomers+' khách Meta chưa trả đủ referral. Khách quay lại từ QC cũ được tính thêm khi đối chiếu được post/Reel với creative.</div>'
    : '';
  const unresolved=report.unresolvedCount
    ? '<div class="notice"><b>Còn '+Number(report.unresolvedCount||0)+' lượt có dấu vết quảng cáo nhưng chưa xác định duy nhất một QC.</b> Hệ thống không tự gán theo Page hoặc tài khoản để tránh sai hiệu quả.</div>'
    : '';
  const exportBar='<div class="export-actions"><a class="btn green" href="/export?type=leads&format=xlsx&from='+encodeURIComponent(p.since)+'&to='+encodeURIComponent(p.until)+'&account='+encodeURIComponent(selected)+'">Xuất Excel</a><a class="btn" href="/export?type=leads&format=csv&from='+encodeURIComponent(p.since)+'&to='+encodeURIComponent(p.until)+'&account='+encodeURIComponent(selected)+'">Xuất CSV</a><a class="btn" href="'+esc(req.originalUrl||'/leads')+'">Xóa lọc cột</a></div>';
  const body='<div class="top"><div><h1>Khách hàng / Lead</h1><div>Đếm theo tài khoản QC → campaign → ad set → ad; gồm QC đang chạy, đã tắt và khách quay lại từ bài quảng cáo cũ · '+esc(p.since)+' → '+esc(p.until)+'</div></div>'+exportBar+'</div>'
    +filterForm(p,accounts,selected)
    +(errors.length?'<div class="notice error">'+errors.map(esc).join('<br>')+'</div>':'')+discrepancy+unresolved
    +'<div class="stats"><div class="stat">Khách quảng cáo theo QC<b>'+performance.effectiveCustomers+'</b></div><div class="stat">Meta ghi nhận mới<b>'+performance.metaCustomers+'</b></div><div class="stat">Đã nối danh tính<b>'+performance.matchedCustomers+'</b></div><div class="stat">Chưa nối danh tính Meta<b>'+performance.unmatchedCustomers+'</b></div><div class="stat">Chưa xác định đúng QC<b>'+Number(report.unresolvedCount||0)+'</b></div><div class="stat">QC có khách<b>'+performance.adsWithCustomers+'</b></div></div>'
    +'<div class="card table"><h2 style="margin:0 0 10px">Hiệu quả theo quảng cáo — Meta + attribution lịch sử</h2><table class="aiguka-data-table meta-ad-performance-table"><thead><tr><th>#</th><th>Tài khoản QC</th><th>Campaign</th><th>Ad set</th><th>Quảng cáo</th><th>Trạng thái</th><th>Chi tiêu</th><th>Khách Meta</th><th>Đã nối tên</th><th>Khách tính hiệu quả</th><th>Chưa nối tên</th></tr></thead><tbody>'+(performanceRows||'<tr><td colspan="11">Chưa có dữ liệu quảng cáo trong khoảng ngày đã chọn.</td></tr>')+'</tbody></table></div>'
    +'<div class="card table"><h2 style="margin:0 0 10px">Danh tính khách đã đối chiếu được</h2><table class="aiguka-data-table lead-report-table" data-meta-messages="'+performance.effectiveCustomers+'" data-customer-count="'+ordered.length+'"><thead><tr><th>#</th><th>Khách hàng <span class="lead-head-count customers">Khách '+ordered.length+'</span></th><th>SĐT/Zalo <span class="lead-head-count contacts">Có '+contactCount+'</span></th><th>Tài khoản QC</th><th>Campaign</th><th>Ad set</th><th>Quảng cáo</th><th>Sản phẩm</th><th>Nguồn khách</th><th>Tag Pancake</th><th>Tin cuối</th><th>Giờ tài khoản</th></tr></thead><tbody>'+(detailRows||'<tr><td colspan="12">Chưa nối được danh tính khách với QC trong khoảng ngày đã chọn.</td></tr>')+'</tbody></table></div>';
  res.type("html").send(layout("Khách hàng Lead",body,"leads"));
}

`;

  source = source.slice(0, nextPageStart) + page + source.slice(installStart);
  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`REEL_ATTRIBUTION_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Reel comments and old/paused ad creatives are included in Lead attribution");
}
