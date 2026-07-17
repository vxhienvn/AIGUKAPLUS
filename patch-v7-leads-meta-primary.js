import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");

if (source.includes("AIGUKA_META_PRIMARY_LEADS_V1")) {
  console.log("[AIGUKA] Meta-primary leads already patched");
  process.exitCode = 0;
} else {
  const leadsStart = source.indexOf("async function leadsPage(req,res) {");
  const leadsEnd = source.indexOf("\n\nexport function installStableV7Dashboard", leadsStart);
  if (leadsStart < 0 || leadsEnd < 0) {
    throw new Error("V7_META_LEADS_ANCHOR_NOT_FOUND:leadsPage");
  }

  const helpers = String.raw`// AIGUKA_META_PRIMARY_LEADS_V1
const META_LEADS_SUPABASE_URL = String(process.env.SUPABASE_URL || "https://ezygfpeeqbbirdeazene.supabase.co").replace(/\/$/, "");
const META_LEADS_SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

async function fetchMetaCustomerLeads(since, until) {
  if (!META_LEADS_SUPABASE_URL || !META_LEADS_SUPABASE_KEY) {
    return { rows: [], error: "Thiếu SUPABASE_SERVICE_ROLE_KEY nên chưa đọc được khách Meta đa Trang" };
  }
  if (!cache.metaLeads) cache.metaLeads = new Map();
  const key = String(since) + ":" + String(until);
  const hit = cache.metaLeads.get(key);
  if (hit && Date.now() - hit.time < 60000) return hit.data;
  const result = { rows: [], error: null };
  try {
    for (let offset = 0; offset < 10000; offset += 1000) {
      const params = new URLSearchParams({
        select: "*",
        and: "(report_date.gte." + since + ",report_date.lte." + until + ")",
        order: "last_message_at.desc",
        limit: "1000",
        offset: String(offset),
      });
      const response = await fetch(META_LEADS_SUPABASE_URL + "/rest/v1/v8_meta_customer_leads_daily?" + params.toString(), {
        headers: {
          apikey: META_LEADS_SUPABASE_KEY,
          authorization: "Bearer " + META_LEADS_SUPABASE_KEY,
        },
        signal: AbortSignal.timeout(30000),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => []);
      if (!response.ok || !Array.isArray(payload)) {
        throw new Error(payload?.message || payload?.error || "SUPABASE_META_LEADS_" + response.status);
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
        page_id: String(row.page_id || ""),
        page_name: row.page_name || "",
        conversation_id: String(row.conversation_id || row.sender_id || row.customer_id || ""),
        source_type: "Meta Business",
        updated_at: row.last_message_at,
        last_customer_message_at: row.last_message_at,
        last_message_is_customer: true,
        message_count: Number(row.message_count || 0),
        has_phone: Boolean(row.has_phone || phones.length),
        has_zalo: Boolean(row.has_zalo),
        phones,
        product: row.product_key || "",
        hot_lead: Boolean(row.hot_lead),
        tags: Array.from(new Set([
          ...(Array.isArray(row.tags) ? row.tags : []),
          ...(row.has_zalo ? ["Zalo"] : []),
          ...(phones.length ? ["Có SĐT"] : []),
        ])),
        snippet: row.last_snippet || "",
        ad_ids: row.ad_id ? [String(row.ad_id)] : [],
        ad_name: row.ad_title || "",
        dateVerified: true,
      };
    }),
    error: result.error,
  };
  cache.metaLeads.set(key, { time: Date.now(), data });
  return data;
}

function inferLeadAccountsByPage(leads, adsRows) {
  const byAd = new Map((adsRows || []).map((ad) => [String(ad.adId || ""), ad]));
  const pageAccounts = new Map();
  for (const ad of adsRows || []) {
    const postId = String(ad.postId || "");
    const pageId = postId.includes("_") ? postId.split("_")[0] : "";
    if (!pageId || !ad.accountId) continue;
    if (!pageAccounts.has(pageId)) pageAccounts.set(pageId, new Map());
    pageAccounts.get(pageId).set(String(ad.accountId), ad);
  }
  for (const lead of leads || []) {
    const direct = byAd.get(String(lead.adId || ""));
    if (direct) {
      lead.accountId = direct.accountId;
      lead.accountName = direct.accountName;
      lead.campaignName = direct.campaignName;
      lead.adsetName = direct.adsetName;
      lead.adName = direct.adName || lead.adName;
      continue;
    }
    const pageId = String(lead.page_id || "");
    const candidates = pageAccounts.get(pageId);
    if (!lead.accountId && candidates && candidates.size === 1) {
      const only = [...candidates.values()][0];
      lead.accountId = only.accountId;
      lead.accountName = only.accountName;
      lead.attributionMethod = "page_account";
    }
  }
  return leads;
}

async function loadUnifiedLeadReport(p, selected = "all") {
  const [accounts, meta, pancake, metaCustomers] = await Promise.all([
    getAccounts(),
    fetchAds(p.since, p.until, selected),
    fetchPancake(3000),
    fetchMetaCustomerLeads(p.since, p.until),
  ]);
  let leads = mapLeads(
    [...(metaCustomers.rows || []), ...(pancake.rows || [])],
    meta.rows || [],
    p.since,
    p.until,
  );
  leads = inferLeadAccountsByPage(leads, meta.rows || []);
  if (selected !== "all") {
    leads = leads.filter((row) => act(row.accountId) === selected);
  }
  leads.sort(
    (left, right) =>
      new Date(right.last_customer_message_at || right.updated_at || 0) -
      new Date(left.last_customer_message_at || left.updated_at || 0),
  );
  return { accounts, meta, pancake, metaCustomers, leads };
}

async function leadsPage(req,res) {
  const p = period(req.query, "dashboard");
  const selected = String(req.query.account || "all") === "all" ? "all" : act(req.query.account);
  const report = await loadUnifiedLeadReport(p, selected);
  const accounts = report.accounts;
  const meta = report.meta;
  const pancake = report.pancake;
  const metaCustomers = report.metaCustomers;
  const leads = report.leads;
  const rows = leads.map((x,i) => {
    const identity = [x.conversation_id, x.page_name].filter(Boolean).join(" · ");
    const customer = x.showCustomerName === false ? "" : "<b>" + esc(x.name) + "</b><br><small>" + esc(identity) + "</small>";
    const contact = esc(x.phones?.join(", ") || "") + (x.has_zalo ? "<br>Zalo" : "");
    const campaign = esc(x.campaignName || "") + "<br><small>" + esc(x.adsetName || "") + "</small>";
    const tags = (x.tags || []).map((tag) => "<span>" + esc(tag) + "</span>").join("");
    return "<tr><td>" + (i + 1) + "</td><td>" + customer + "</td><td>" + contact + "</td><td>" + esc(x.accountName || "Chưa xác định") + "</td><td>" + campaign + "</td><td>" + esc(x.adName || "") + "</td><td>" + esc(x.product || "") + "</td><td>" + esc(x.source_type || "Meta Business") + "</td><td class=\"tags\">" + tags + "</td><td>" + esc(x.snippet || "") + "</td><td>" + esc(dateKey(x.last_customer_message_at || x.updated_at)) + "</td></tr>";
  }).join("");
  const errors = [
    ...(meta.errors || []),
    ...(metaCustomers.error ? [metaCustomers.error] : []),
    ...(pancake.error ? [pancake.error] : []),
  ];
  const body = "<div class=\"top\"><div><h1>Khách hàng / Lead</h1><div>Meta Business là nguồn chính · Pancake chỉ bổ sung dữ liệu còn thiếu · " + esc(p.since) + " → " + esc(p.until) + "</div></div><a class=\"btn green\" href=\"/export?type=leads&from=" + encodeURIComponent(p.since) + "&to=" + encodeURIComponent(p.until) + "&account=" + encodeURIComponent(selected) + "\">Xuất CSV</a></div>" + filterForm(p, accounts, selected) + (errors.length ? "<div class=\"notice error\">" + errors.map(esc).join("<br>") + "</div>" : "") + "<div class=\"stats\"><div class=\"stat\">Khách đang hiển thị<b>" + leads.length + "</b></div><div class=\"stat\">Tin nhắn Meta<b>" + meta.totalMessages + "</b></div><div class=\"stat\">Tài khoản QC<b>" + accounts.length + "</b></div></div><div class=\"card table\"><table data-meta-messages=\"" + meta.totalMessages + "\" data-customer-count=\"" + leads.length + "\"><thead><tr><th>#</th><th>Khách hàng</th><th>SĐT/Zalo</th><th>Tài khoản QC</th><th>Campaign/Ad set</th><th>Quảng cáo</th><th>Sản phẩm</th><th>Nguồn khách</th><th>Tag Pancake</th><th>Tin cuối</th><th>Ngày</th></tr></thead><tbody>" + (rows || "<tr><td colspan=\"11\">Không có khách phù hợp.</td></tr>") + "</tbody></table></div>";
  res.type("html").send(layout("Khách hàng Lead", body, "leads"));
}
`;

  source = source.slice(0, leadsStart) + helpers + source.slice(leadsEnd);

  const exportStart = source.indexOf("  app.get('/export',async(req,res)=>{");
  const exportEnd = source.indexOf("\n  console.log('[AIGUKA]", exportStart);
  if (exportStart < 0 || exportEnd < 0) {
    throw new Error("V7_META_LEADS_ANCHOR_NOT_FOUND:export");
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
        x.campaignName||'',
        x.adsetName||'',
        x.adName||'',
        x.product||'',
        x.source_type||'Meta Business',
        (x.tags||[]).join('|'),
        x.snippet||'',
        dateKey(x.last_customer_message_at||x.updated_at),
      ]);
      head=['Khách hàng','SĐT','Zalo','Tài khoản QC','Campaign','Ad set','Quảng cáo','Sản phẩm','Nguồn khách','Tag Pancake','Tin cuối','Ngày'];
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
  console.log("[AIGUKA] Leads use Meta multi-Page data first; Pancake only enriches gaps");
}
