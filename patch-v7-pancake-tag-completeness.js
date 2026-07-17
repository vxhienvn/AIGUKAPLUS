import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");

if (source.includes("AIGUKA_PANCAKE_TAG_COMPLETENESS_V4")) {
  console.log("[AIGUKA] Pancake tag completeness V4 already installed");
} else {
  const fetchPattern = /async function fetchPancake\(limit = 500, force = false\) \{[\s\S]*?\n\}/;
  if (!fetchPattern.test(source)) throw new Error("PANCAKE_TAG_COMPLETENESS_FETCH_ANCHOR_NOT_FOUND");

  source = source.replace(fetchPattern, String.raw`// AIGUKA_PANCAKE_TAG_COMPLETENESS_V4
function pancakeUniqueText(values = []) {
  const map = new Map();
  for (const value of values || []) {
    const text = typeof value === "string"
      ? value.trim()
      : String(value?.text || value?.name || value?.label || value?.title || "").trim();
    if (!text) continue;
    const key = text.normalize("NFKC").toLocaleLowerCase("vi");
    if (!map.has(key)) map.set(key, text);
  }
  return [...map.values()];
}

function pancakePageId(row = {}) {
  const direct = String(row.page_id || row.pageId || "").trim();
  if (direct) return direct;
  const conversationId = String(row.conversation_id || row.id || "");
  const match = conversationId.match(/^(\d{5,32})_/);
  return match?.[1] || String(process.env.PANCAKE_PAGE_ID || process.env.META_PAGE_ID || "");
}

function pancakeSenderId(row = {}) {
  const values = [row.sender_id, row.customer_id, row.from?.id, row.page_customer?.psid, row.customers?.[0]?.fb_id];
  for (const value of values) {
    const text = String(value || "").trim();
    if (/^\d{5,32}$/.test(text)) return text;
  }
  const conversationId = String(row.conversation_id || row.id || "");
  return conversationId.match(/_(\d{5,32})$/)?.[1] || "";
}

function pancakeCustomerIdentity(row = {}) {
  const pageId = pancakePageId(row);
  const senderId = pancakeSenderId(row);
  return pageId && senderId ? pageId + "|" + senderId : "";
}

function pancakeMergeRows(left = {}, right = {}) {
  const leftTime = new Date(left.last_customer_message_at || left.updated_at || 0).getTime() || 0;
  const rightTime = new Date(right.last_customer_message_at || right.updated_at || 0).getTime() || 0;
  const newest = rightTime >= leftTime ? right : left;
  const older = newest === right ? left : right;
  const phones = pancakeUniqueText([...(left.phones || []), ...(right.phones || [])]);
  const tags = pancakeUniqueText([...(left.tags || []), ...(right.tags || []), ...(left.pancake_tags || []), ...(right.pancake_tags || [])]);
  const adIds = pancakeUniqueText([...(left.ad_ids || []), ...(right.ad_ids || [])]);
  return {
    ...older,
    ...newest,
    page_id: pancakePageId(newest) || pancakePageId(older),
    sender_id: pancakeSenderId(newest) || pancakeSenderId(older),
    customer_id: pancakeSenderId(newest) || pancakeSenderId(older) || newest.customer_id || older.customer_id || "",
    phones,
    tags,
    pancake_tags: pancakeUniqueText([...(left.pancake_tags || []), ...(right.pancake_tags || []), ...tags]),
    ad_ids: adIds,
    has_phone: Boolean(left.has_phone || right.has_phone || phones.length),
    has_zalo: Boolean(left.has_zalo || right.has_zalo || tags.some(tag => String(tag).toLowerCase() === "zalo")),
    hot_lead: Boolean(left.hot_lead || right.hot_lead),
    product: (newest.product && newest.product !== "Khác" ? newest.product : "") || (older.product && older.product !== "Khác" ? older.product : "") || newest.product || older.product || "",
  };
}

async function pancakeIntegrationEnabledForReports() {
  const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) return true;
  try {
    const response = await fetch(supabaseUrl + "/rest/v1/v8_integration_runtime?integration_key=eq.pancake&select=connection_enabled,message_sync_enabled&limit=1", {
      headers: { apikey: serviceKey, authorization: "Bearer " + serviceKey },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    const rows = await response.json().catch(() => []);
    if (!response.ok || !Array.isArray(rows) || !rows[0]) return true;
    return rows[0].connection_enabled !== false && rows[0].message_sync_enabled !== false;
  } catch {
    return true;
  }
}

async function pancakeReadAllCachedRows(maxRows = 10000) {
  const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) return [];
  const rows = [];
  const target = Math.min(Math.max(Number(maxRows) || 10000, 1), 10000);
  for (let offset = 0; offset < target; offset += 1000) {
    const params = new URLSearchParams({
      select: "conversation_id,page_id,customer_id,staff_tags,last_customer_message_at,updated_at,conversation",
      order: "last_customer_message_at.desc.nullslast",
      limit: "1000",
      offset: String(offset),
    });
    const response = await fetch(supabaseUrl + "/rest/v1/v8_pancake_conversation_cache?" + params.toString(), {
      headers: { apikey: serviceKey, authorization: "Bearer " + serviceKey },
      signal: AbortSignal.timeout(30000),
      cache: "no-store",
    });
    const batch = await response.json().catch(() => []);
    if (!response.ok || !Array.isArray(batch)) throw new Error(batch?.message || batch?.error || ("SUPABASE_PANCAKE_CACHE_" + response.status));
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows.map(item => {
    const conversation = item?.conversation && typeof item.conversation === "object" ? { ...item.conversation } : {};
    conversation.id = conversation.id || item.conversation_id;
    conversation.page_id = conversation.page_id || item.page_id;
    conversation.customer_id = conversation.customer_id || item.customer_id;
    conversation.staff_tags = pancakeUniqueText([...(conversation.staff_tags || []), ...(item.staff_tags || [])]);
    conversation.last_customer_message_at = conversation.last_customer_message_at || item.last_customer_message_at;
    conversation.updated_at = conversation.updated_at || item.updated_at || item.last_customer_message_at;
    const built = pancakeBuildCustomerRow(conversation);
    const tags = pancakeUniqueText([...(built.tags || []), ...(item.staff_tags || [])]);
    return {
      ...built,
      page_id: String(item.page_id || built.page_id || ""),
      sender_id: pancakeSenderId(built) || String(item.customer_id || ""),
      customer_id: pancakeSenderId(built) || String(item.customer_id || built.customer_id || ""),
      conversation_id: built.conversation_id || item.conversation_id,
      tags,
      pancake_tags: pancakeUniqueText([...(built.pancake_tags || []), ...(item.staff_tags || [])]),
      has_zalo: Boolean(built.has_zalo || tags.some(tag => String(tag).toLowerCase() === "zalo")),
    };
  });
}

function pancakeCompleteCustomerTags(rows = []) {
  const customerMap = new Map();
  for (const row of rows) {
    const key = pancakeCustomerIdentity(row);
    if (!key) continue;
    customerMap.set(key, pancakeMergeRows(customerMap.get(key) || {}, row));
  }
  return rows.map(row => {
    const extra = customerMap.get(pancakeCustomerIdentity(row));
    return extra ? pancakeMergeRows(row, extra) : row;
  });
}

async function fetchPancake(limit = 500, force = false) {
  const key = "complete:" + String(limit);
  const hit = cache.pancake.get(key);
  if (!force && hit && Date.now() - hit.time < 60 * 1000) return hit.data;
  const result = { rows: [], error: null };
  if (!(await pancakeIntegrationEnabledForReports())) {
    cache.pancake.set(key, { time: Date.now(), data: result });
    return result;
  }
  const errors = [];
  let liveRows = [];
  let cachedRows = [];
  try {
    liveRows = (await pancakeFetchConversations(Math.max(Number(limit) || 500, 3000))).map(pancakeBuildCustomerRow);
  } catch (error) {
    errors.push("Pancake trực tiếp: " + error.message);
  }
  try {
    cachedRows = await pancakeReadAllCachedRows(10000);
  } catch (error) {
    errors.push("Lịch sử Pancake: " + error.message);
  }

  const byConversation = new Map();
  for (const row of [...cachedRows, ...liveRows]) {
    const pageId = pancakePageId(row);
    const conversationId = String(row.conversation_id || row.id || "");
    const senderId = pancakeSenderId(row);
    const keyValue = pageId + "|" + (conversationId || senderId);
    if (!keyValue || keyValue === "|") continue;
    byConversation.set(keyValue, pancakeMergeRows(byConversation.get(keyValue) || {}, { ...row, page_id: pageId, sender_id: senderId }));
  }
  result.rows = pancakeCompleteCustomerTags([...byConversation.values()]);
  result.rows.sort((left, right) => new Date(right.last_customer_message_at || right.updated_at || 0) - new Date(left.last_customer_message_at || left.updated_at || 0));
  result.error = result.rows.length ? null : (errors.join(" | ") || null);
  cache.pancake.set(key, { time: Date.now(), data: result });
  return result;
}`);

  const enrichPattern = /function enrichMetaLeadsWithPancake\(metaLeads, pancakeRows\) \{[\s\S]*?\n\}/;
  if (!enrichPattern.test(source)) throw new Error("PANCAKE_TAG_COMPLETENESS_ENRICH_ANCHOR_NOT_FOUND");
  source = source.replace(enrichPattern, String.raw`function enrichMetaLeadsWithPancake(metaLeads, pancakeRows) {
  const pancakeByIdentity = new Map();
  for (const row of pancakeRows || []) {
    const key = pancakeCustomerIdentity(row) || leadIdentity(row);
    if (!key || key === "name|") continue;
    pancakeByIdentity.set(key, pancakeMergeRows(pancakeByIdentity.get(key) || {}, row));
  }
  return (metaLeads || []).map(lead => {
    const key = pancakeCustomerIdentity(lead) || leadIdentity(lead);
    const extra = pancakeByIdentity.get(key);
    if (!extra) return lead;
    const phones = pancakeUniqueText([...(lead.phones || []), ...(extra.phones || [])]);
    const tags = pancakeUniqueText([...(lead.tags || []), ...(extra.tags || []), ...(extra.pancake_tags || [])]);
    return {
      ...lead,
      phones,
      tags,
      pancake_tags: pancakeUniqueText([...(extra.pancake_tags || []), ...(extra.tags || [])]),
      has_phone: Boolean(lead.has_phone || extra.has_phone || phones.length),
      has_zalo: Boolean(lead.has_zalo || extra.has_zalo || tags.some(tag => String(tag).toLowerCase() === "zalo")),
      product: (lead.product && lead.product !== "Khác" ? lead.product : "") || (extra.product && extra.product !== "Khác" ? extra.product : "") || lead.product || extra.product || "",
      hot_lead: Boolean(lead.hot_lead || extra.hot_lead),
      source_type: "Meta Business + Pancake",
      pancake_matched: true,
    };
  });
}`);

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`PANCAKE_TAG_COMPLETENESS_SYNTAX_FAILED:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Complete Pancake tags installed for Dashboard, Daily and Leads");
}
