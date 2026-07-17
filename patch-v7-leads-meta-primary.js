import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");

if (source.includes("AIGUKA_META_PRIMARY_LEADS_V2")) {
  console.log("[AIGUKA] Meta-primary Leads V2 already patched");
  process.exitCode = 0;
} else {
  const leadsStart = source.indexOf("async function leadsPage(req,res) {");
  const leadsEnd = source.indexOf("\n\nexport function installStableV7Dashboard", leadsStart);
  if (leadsStart < 0 || leadsEnd < 0) {
    throw new Error("V7_META_LEADS_V2_ANCHOR_NOT_FOUND:leadsPage");
  }

  const helpers = String.raw`// AIGUKA_META_PRIMARY_LEADS_V2
const META_LEADS_SUPABASE_URL = String(process.env.SUPABASE_URL || "https://ezygfpeeqbbirdeazene.supabase.co").replace(/\/$/, "");
const META_LEADS_SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function shiftLeadDate(value, days) {
  const date = new Date(String(value) + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function leadSenderId(row) {
  const pageId = String(row.page_id || "");
  const candidates = [row.sender_id, row.customer_id, row.conversation_id];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (!value) continue;
    if (/^\d{5,32}$/.test(value)) return value;
    if (pageId && value.startsWith(pageId + "_")) {
      const tail = value.slice(pageId.length + 1);
      if (/^\d{5,32}$/.test(tail)) return tail;
    }
    const match = value.match(/(?:^|_)(\d{5,32})$/);
    if (match?.[1]) return match[1];
  }
  return "";
}

function leadIdentity(row) {
  const pageId = String(row.page_id || process.env.PANCAKE_PAGE_ID || process.env.META_PAGE_ID || "");
  const senderId = leadSenderId(row);
  if (pageId && senderId) return pageId + "|" + senderId;
  const phone = String(row.phones?.[0] || row.phone || "").replace(/\D/g, "");
  if (phone) return "phone|" + phone;
  return "name|" + String(row.name || row.customer_name || "").trim().toLowerCase();
}

async function fetchMetaConversationStarts(since, until) {
  if (!META_LEADS_SUPABASE_URL || !META_LEADS_SUPABASE_KEY) {
    return { rows: [], error: "Thiếu SUPABASE_SERVICE_ROLE_KEY nên chưa đọc được khách Meta đa Trang" };
  }
  if (!cache.metaConversationStarts) cache.metaConversationStarts = new Map();
  const key = String(since) + ":" + String(until);
  const hit = cache.metaConversationStarts.get(key);
  if (hit && Date.now() - hit.time < 60000) return hit.data;
  const result = { rows: [], error: null };
  const startIso = shiftLeadDate(since, -2) + "T00:00:00Z";
  const endIso = shiftLeadDate(until, 3) + "T00:00:00Z";
  try {
    for (let offset = 0; offset < 10000; offset += 1000) {
      const params = new URLSearchParams();
      params.set("select", "*");
      params.append("conversation_started_at", "gte." + startIso);
      params.append("conversation_started_at", "lt." + endIso);
      params.set("order", "conversation_started_at.desc");
      params.set("limit", "1000");
      params.set("offset", String(offset));
      const response = await fetch(META_LEADS_SUPABASE_URL + "/rest/v1/v8_meta_conversation_starts?" + params.toString(), {
        headers: {
          apikey: META_LEADS_SUPABASE_KEY,
          authorization: "Bearer " + META_LEADS_SUPABASE_KEY,
        },
        signal: AbortSignal.timeout(30000),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => []);
      if (!response.ok || !Array.isArray(payload)) {
        throw new Error(payload?.message || payload?.error || "SUPABASE_META_STARTS_" + response.status);
      }
      result.rows.push(...payload);
      if (payload.length < 1000) break;
    }
  } catch (error) {
    result.error = error.message;
  }
  const data = {
    rows: result.rows.map((row) => {
      const phones = [row.phone].filter(Boolean).map(String);
      return {
        name: row.customer_name || ("Khách ..." + String(row.sender_id || "").slice(-6)),
        customer_id: String(row.sender_id || row.customer_id || ""),
        sender_id: String(row.sender_id || ""),
        page_id: String(row.page_id || ""),
        page_name: row.page_name || "",
        conversation_id: String(row.conversation_id || row.sender_id || row.customer_id || ""),
        source_type: "Meta Business",
        conversation_started_at: row.conversation_started_at,
        updated_at: row.last_message_at,
        last_customer_message_at: row.last_message_at,
        message_count: Number(row.message_count || 0),
        has_phone: Boolean(row.has_phone || phones.length),
        has_zalo: Boolean(row.has_zalo),
        phones,
        product: row.product_key || "",
        hot_lead: Number(row.lead_score || 0) >= 60,
        tags: Array.from(new Set([
          ...(Array.isArray(row.tags) ? row.tags : []),
          ...(row.has_zalo ? ["Zalo"] : []),
          ...(phones.length ? ["Có SĐT"] : []),
        ])),
        snippet: row.last_message_text || row.first_message_text || "",
        adId: String(row.ad_id || ""),
        adName: row.ad_title || "",
        postId: String(row.post_id || ""),
        referralSource: row.referral_source || "",
        isAdConversation: row.is_ad_conversation === true,
      };
    }),
    error: result.error,
  };
  cache.metaConversationStarts.set(key, { time: Date.now(), data });
  return data;
}

async function resolveLeadAdMap(leads, adsRows, accounts) {
  const map = new Map();
  const accountMap = new Map((accounts || []).map((account) => [act(account.id), account]));
  for (const ad of adsRows || []) {
    map.set(String(ad.adId || ""), { ...ad, accountId: act(ad.accountId), account: accountMap.get(act(ad.accountId)) || null });
  }
  const unknown = [...new Set((leads || []).map((lead) => String(lead.adId || "")).filter((id) => id && !map.has(id)))];
  const token = process.env.META_ACCESS_TOKEN || process.env.META_USER_ACCESS_TOKEN || process.env.FACEBOOK_USER_ACCESS_TOKEN || process.env.USER_ACCESS_TOKEN || "";
  if (token) {
    for (let index = 0; index < unknown.length; index += 50) {
      const ids = unknown.slice(index, index + 50);
      if (!ids.length) continue;
      try {
        const fields = "id,name,account_id,campaign{id,name},adset{id,name}";
        const data = await fetchJson("https://graph.facebook.com/" + GRAPH_VERSION + "/?ids=" + encodeURIComponent(ids.join(",")) + "&fields=" + encodeURIComponent(fields) + "&access_token=" + encodeURIComponent(token));
        for (const [adId, item] of Object.entries(data || {})) {
          const accountId = act(item?.account_id || "");
          const account = accountMap.get(accountId) || null;
          map.set(String(adId), {
            adId: String(adId),
            adName: item?.name || "",
            accountId,
            accountName: account?.name || accountId,
            campaignId: item?.campaign?.id || "",
            campaignName: item?.campaign?.name || "",
            adsetId: item?.adset?.id || "",
            adsetName: item?.adset?.name || "",
            account,
          });
        }
      } catch {}
    }
  }
  return map;
}

function enrichMetaLeadsWithPancake(metaLeads, pancakeRows) {
  const pancakeByIdentity = new Map();
  for (const row of pancakeRows || []) {
    const key = leadIdentity(row);
    if (!key || key === "name|") continue;
    const old = pancakeByIdentity.get(key);
    if (!old || new Date(row.last_customer_message_at || row.updated_at || 0) > new Date(old.last_customer_message_at || old.updated_at || 0)) {
      pancakeByIdentity.set(key, row);
    }
  }
  return (metaLeads || []).map((lead) => {
    const extra = pancakeByIdentity.get(leadIdentity(lead));
    if (!extra) return lead;
    const phones = [...new Set([...(lead.phones || []), ...(extra.phones || [])])];
    const tags = [...new Set([...(lead.tags || []), ...(extra.tags || [])])];
    return {
      ...lead,
      phones,
      tags,
      has_phone: lead.has_phone || extra.has_phone || phones.length > 0,
      has_zalo: lead.has_zalo || extra.has_zalo,
      product: lead.product || extra.product || "",
      hot_lead: lead.hot_lead || extra.hot_lead,
      source_type: "Meta Business + Pancake",
    };
  });
}

function accountLeadDate(lead) {
  const timezone = lead.accountTimezone || "Asia/Ho_Chi_Minh";
  return dateKey(lead.conversation_started_at, timezone);
}

function formatAccountLeadTime(lead) {
  const timezone = lead.accountTimezone || "Asia/Ho_Chi_Minh";
  const date = new Date(lead.conversation_started_at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("vi-VN", { timeZone: timezone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function loadUnifiedLeadReport(p, selected = "all") {
  const [accounts, meta, pancake, starts] = await Promise.all([
    getAccounts(),
    fetchAds(p.since, p.until, selected),
    fetchPancake(3000),
    fetchMetaConversationStarts(p.since, p.until),
  ]);
  const paidCandidates = (starts.rows || []).filter((row) => row.isAdConversation && row.adId);
  const adMap = await resolveLeadAdMap(paidCandidates, meta.rows || [], accounts);
  const paid = [];
  const unresolved = [];
  const seen = new Set();
  for (const row of paidCandidates) {
    const identity = leadIdentity(row);
    if (!identity || seen.has(identity)) continue;
    const ad = adMap.get(String(row.adId || ""));
    if (!ad?.accountId) {
      unresolved.push(row);
      continue;
    }
    const account = ad.account || (accounts || []).find((item) => act(item.id) === act(ad.accountId)) || null;
    const lead = {
      ...row,
      accountId: act(ad.accountId),
      accountName: ad.accountName || account?.name || ad.accountId,
      accountTimezone: account?.timezoneName || account?.timezone_name || "Asia/Ho_Chi_Minh",
      campaignName: ad.campaignName || "",
      adsetName: ad.adsetName || "",
      adName: ad.adName || row.adName || "",
    };
    const localDate = accountLeadDate(lead);
    if (!localDate || localDate < p.since || localDate > p.until) continue;
    if (selected !== "all" && act(lead.accountId) !== selected) continue;
    seen.add(identity);
    paid.push(lead);
  }
  const leads = enrichMetaLeadsWithPancake(paid, pancake.rows || []);
  leads.sort((left, right) => new Date(right.conversation_started_at || 0) - new Date(left.conversation_started_at || 0));
  return {
    accounts,
    meta,
    pancake,
    starts,
    leads,
    unresolvedCount: unresolved.length,
    organicCount: (starts.rows || []).filter((row) => !row.isAdConversation).length,
  };
}

async function leadsPage(req,res) {
  const p = period(req.query, "dashboard");
  const selected = String(req.query.account || "all") === "all" ? "all" : act(req.query.account);
  const report = await loadUnifiedLeadReport(p, selected);
  const accounts = report.accounts;
  const leads = report.leads;
  const rows = leads.map((x,i) => {
    const identity = [x.conversation_id, x.page_name].filter(Boolean).join(" · ");
    const customer = "<b>" + esc(x.name) + "</b><br><small>" + esc(identity) + "</small>";
    const contact = esc(x.phones?.join(", ") || "") + (x.has_zalo ? "<br>Zalo" : "");
    const campaign = esc(x.campaignName || "") + "<br><small>" + esc(x.adsetName || "") + "</small>";
    const tags = (x.tags || []).map((tag) => "<span>" + esc(tag) + "</span>").join("");
    const account = esc(x.accountName || "Chưa xác định") + "<br><small>" + esc(x.accountTimezone || "") + "</small>";
    return "<tr><td>" + (i + 1) + "</td><td>" + customer + "</td><td>" + contact + "</td><td>" + account + "</td><td>" + campaign + "</td><td>" + esc(x.adName || "") + "</td><td>" + esc(x.product || "") + "</td><td>" + esc(x.source_type || "Meta Business") + "</td><td class=\"tags\">" + tags + "</td><td>" + esc(x.snippet || "") + "</td><td>" + esc(formatAccountLeadTime(x)) + "</td></tr>";
  }).join("");
  const accountCount = new Set(leads.map((lead) => act(lead.accountId)).filter(Boolean)).size;
  const errors = [
    ...(report.meta.errors || []),
    ...(report.starts.error ? [report.starts.error] : []),
    ...(report.pancake.error ? [report.pancake.error] : []),
  ];
  const note = report.unresolvedCount ? "<div class=\"notice\">Có " + report.unresolvedCount + " hội thoại quảng cáo chưa đọc được tài khoản QC; chưa cộng vào số khách để tránh gán sai.</div>" : "";
  const body = "<div class=\"top\"><div><h1>Khách hàng / Lead</h1><div>Mỗi khách chỉ tính 1 lần · theo múi giờ riêng của từng tài khoản quảng cáo · " + esc(p.since) + " → " + esc(p.until) + "</div></div><a class=\"btn green\" href=\"/export?type=leads&from=" + encodeURIComponent(p.since) + "&to=" + encodeURIComponent(p.until) + "&account=" + encodeURIComponent(selected) + "\">Xuất CSV</a></div>" + filterForm(p, accounts, selected) + (errors.length ? "<div class=\"notice error\">" + errors.map(esc).join("<br>") + "</div>" : "") + note + "<div class=\"stats\"><div class=\"stat\">Khách quảng cáo duy nhất<b>" + leads.length + "</b></div><div class=\"stat\">Tài khoản có khách<b>" + accountCount + "</b></div><div class=\"stat\">Chưa gắn đúng QC<b>" + report.unresolvedCount + "</b></div></div><div class=\"card table\"><table data-meta-messages=\"" + leads.length + "\" data-customer-count=\"" + leads.length + "\"><thead><tr><th>#</th><th>Khách hàng</th><th>SĐT/Zalo</th><th>Tài khoản QC</th><th>Campaign/Ad set</th><th>Quảng cáo</th><th>Sản phẩm</th><th>Nguồn khách</th><th>Tag Pancake</th><th>Tin cuối</th><th>Giờ tài khoản</th></tr></thead><tbody>" + (rows || "<tr><td colspan=\"11\">Không có khách quảng cáo phù hợp.</td></tr>") + "</tbody></table></div>";
  res.type("html").send(layout("Khách hàng Lead", body, "leads"));
}
`;

  source = source.slice(0, leadsStart) + helpers + source.slice(leadsEnd);

  const exportStart = source.indexOf("  app.get('/export',async(req,res)=>{");
  const exportEnd = source.indexOf("\n  console.log('[AIGUKA]", exportStart);
  if (exportStart < 0 || exportEnd < 0) {
    throw new Error("V7_META_LEADS_V2_ANCHOR_NOT_FOUND:export");
  }

  const exportRoute = String.raw`  app.get('/export',async(req,res)=>{
    const p=period(req.query,'dashboard');
    const selected=String(req.query.account||'all')==='all'?'all':act(req.query.account);
    const type=String(req.query.type||'daily');
    let rows=[];
    let head=[];
    if(type==='leads'){
      const report=await loadUnifiedLeadReport(p,selected);
      rows=report.leads.map(x=>[
        x.name,
        x.phones?.join(' ')||'',
        x.has_zalo?'Zalo':'',
        x.accountName||'',
        x.accountTimezone||'',
        x.campaignName||'',
        x.adsetName||'',
        x.adName||'',
        x.product||'',
        x.source_type||'Meta Business',
        (x.tags||[]).join('|'),
        x.snippet||'',
        formatAccountLeadTime(x),
      ]);
      head=['Khách hàng','SĐT','Zalo','Tài khoản QC','Múi giờ tài khoản','Campaign','Ad set','Quảng cáo','Sản phẩm','Nguồn khách','Tag Pancake','Tin cuối','Giờ tài khoản'];
    }else{
      const d=await fetchDaily(p.since,p.until,selected);
      rows=d.rows.map(x=>[
        x.date,
        x.accountName,
        x.accountId,
        x.paymentMethod||(x.cardLast4?'Thẻ •••• '+x.cardLast4:''),
        x.spend,
        x.messages,
      ]);
      head=['Ngày','Tài khoản QC','ID tài khoản','Thẻ / Phương thức','Chi tiêu','Tin nhắn'];
    }
    res.setHeader('content-type','text/csv; charset=utf-8');
    res.setHeader('content-disposition','attachment; filename="aiguka-'+type+'-'+p.since+'-'+p.until+'.csv"');
    res.send('\ufeff'+[head,...rows].map(r=>r.map(csv).join(',')).join('\n'));
  });`;

  source = source.slice(0, exportStart) + exportRoute + source.slice(exportEnd);
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA] Leads V2: unique Meta conversation starts, direct ad attribution, per-account timezone, Pancake enrichment only");
}
