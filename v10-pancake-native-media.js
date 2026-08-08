import crypto from "node:crypto";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").trim().replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "").trim();
const PANCAKE_TOKEN = String(process.env.PANCAKE_PAGE_ACCESS_TOKEN || "").trim();
const PANCAKE_BASE = String(process.env.PANCAKE_BASE_URL || "https://pages.fm").trim().replace(/\/$/, "");
const LOOKUP_PAGES = Math.max(3, Math.min(30, Number(process.env.AIGUKA_V10_PANCAKE_CONVERSATION_PAGES || 15)));
const RATE_DELAY_MS = Math.max(220, Number(process.env.AIGUKA_V10_PANCAKE_UPLOAD_DELAY_MS || 260));
const conversationCache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function configured() {
  return Boolean(CORE_BASE && CORE_KEY && PANCAKE_TOKEN);
}

async function core(path, options = {}) {
  const response = await fetch(`${CORE_BASE}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: CORE_KEY,
      authorization: `Bearer ${CORE_KEY}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 30000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 800) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `CORE_HTTP_${response.status}`);
  return data;
}

async function pancakeJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body,
    signal: AbortSignal.timeout(options.timeout || 45000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw: raw.slice(0, 1200) }; }
  if (!response.ok || data?.success === false) {
    const error = new Error(data?.message || data?.error || data?.raw || `PANCAKE_HTTP_${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function conversationId(row = {}) {
  return String(row.id || row.conversation_id || row.thread_id || "").trim();
}

function senderIds(row = {}) {
  const values = [
    row.sender_id,
    row.customer_id,
    row.psid,
    row.from_id,
    row.from?.id,
    row.user?.id,
    row.customer?.id,
    row.page_customer?.psid,
    row.customers?.[0]?.fb_id,
  ];
  const suffix = conversationId(row).match(/_(\d{5,32})$/)?.[1];
  if (suffix) values.push(suffix);
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function lookupConversation(pageId, recipientId, force = false) {
  const cacheKey = `${pageId}|${recipientId}`;
  const cached = conversationCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < 5 * 60_000) return cached.id;

  let last = "";
  for (let pageNo = 0; pageNo < LOOKUP_PAGES; pageNo += 1) {
    let url = `${PANCAKE_BASE}/api/public_api/v2/pages/${encodeURIComponent(pageId)}/conversations?page_access_token=${encodeURIComponent(PANCAKE_TOKEN)}`;
    if (last) url += `&last_conversation_id=${encodeURIComponent(last)}`;
    const data = await pancakeJson(url, { timeout: 35000 });
    const rows = Array.isArray(data?.conversations) ? data.conversations : Array.isArray(data?.data) ? data.data : [];
    const found = rows.find((row) => senderIds(row).includes(String(recipientId)));
    if (found) {
      const id = conversationId(found);
      if (!id) throw new Error("PANCAKE_CONVERSATION_ID_MISSING");
      conversationCache.set(cacheKey, { at: Date.now(), id });
      return id;
    }
    const tail = rows[rows.length - 1];
    const next = conversationId(tail);
    if (!next || next === last || rows.length === 0) break;
    last = next;
  }
  throw new Error(`PANCAKE_CONVERSATION_NOT_FOUND:${pageId}:${recipientId}`);
}

function driveFileId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    const queryId = String(url.searchParams.get("id") || "").trim();
    if (queryId) return queryId;
    return url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,200})/)?.[1] || "";
  } catch {
    return text.match(/(?:[?&]id=|\/file\/d\/)([A-Za-z0-9_-]{10,200})/)?.[1] || "";
  }
}

function deliveryUrl(value) {
  const sourceUrl = String(value || "").trim();
  const fileId = driveFileId(sourceUrl);
  if (!fileId) return sourceUrl;
  const configuredProxy = String(process.env.AIGUKA_DRIVE_IMAGE_PROXY_BASE || "").trim().replace(/\/$/, "");
  const supabase = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const endpoint = configuredProxy || (supabase ? `${supabase}/functions/v1/aiguka-drive-image-proxy` : "");
  return endpoint ? `${endpoint}?file_id=${encodeURIComponent(fileId)}` : sourceUrl;
}

function assetKey(sourceUrl) {
  return crypto.createHash("sha256").update(String(sourceUrl || "")).digest("hex");
}

function safeFileName(asset = {}, contentType = "image/jpeg") {
  const ext = /png/i.test(contentType) ? ".png" : /webp/i.test(contentType) ? ".webp" : /gif/i.test(contentType) ? ".gif" : ".jpg";
  const base = String(asset.title || asset.asset_id || asset.catalog_key || "aiguka-product")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "aiguka-product";
  return `${base}${ext}`;
}

function extractContentId(data) {
  const values = [
    data?.content_id,
    data?.id,
    data?.data?.content_id,
    data?.data?.id,
    data?.content_ids?.[0],
    data?.contents?.[0]?.content_id,
    data?.contents?.[0]?.id,
    Array.isArray(data?.data) ? data.data[0]?.content_id : null,
    Array.isArray(data?.data) ? data.data[0]?.id : null,
  ];
  return String(values.find((value) => value !== undefined && value !== null && String(value).trim()) || "").trim();
}

function extractMessageId(data) {
  const values = [data?.message_id, data?.id, data?.data?.message_id, data?.data?.id, data?.message?.id];
  return String(values.find((value) => value !== undefined && value !== null && String(value).trim()) || "").trim();
}

async function cacheRow(pageId, sourceUrl) {
  if (!configured()) return null;
  const key = assetKey(sourceUrl);
  const rows = await core(`v10_pancake_media_cache?select=content_id,status,mime_type,file_name,last_error&page_id=eq.${encodeURIComponent(pageId)}&asset_key=eq.${key}&limit=1`, { timeout: 12000 }).catch(() => []);
  return rows?.[0] || null;
}

async function saveCache(pageId, sourceUrl, patch = {}) {
  const key = assetKey(sourceUrl);
  const now = new Date().toISOString();
  await core("v10_pancake_media_cache?on_conflict=page_id,asset_key", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      page_id: String(pageId),
      asset_key: key,
      source_url: String(sourceUrl),
      updated_at: now,
      ...patch,
    },
  }).catch(() => {});
}

async function uploadWithField(pageId, blob, fileName, field) {
  const form = new FormData();
  form.append(field, blob, fileName);
  const url = `${PANCAKE_BASE}/api/public_api/v1/pages/${encodeURIComponent(pageId)}/upload_contents?page_access_token=${encodeURIComponent(PANCAKE_TOKEN)}`;
  return pancakeJson(url, { method: "POST", body: form, timeout: 60000 });
}

async function uploadAsset(pageId, asset) {
  const sourceUrl = String(asset?.source_url || asset?.url || "").trim();
  if (!sourceUrl) throw new Error("PANCAKE_MEDIA_SOURCE_URL_MISSING");
  const existing = await cacheRow(pageId, sourceUrl);
  if (existing?.status === "ready" && existing?.content_id) return existing.content_id;

  const url = deliveryUrl(sourceUrl);
  const response = await fetch(url, { signal: AbortSignal.timeout(45000), cache: "no-store" });
  if (!response.ok) throw new Error(`PANCAKE_MEDIA_FETCH_HTTP_${response.status}`);
  const contentType = String(response.headers.get("content-type") || "image/jpeg").split(";")[0].trim() || "image/jpeg";
  if (!/^image\//i.test(contentType)) throw new Error(`PANCAKE_MEDIA_NOT_IMAGE:${contentType}`);
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength) throw new Error("PANCAKE_MEDIA_EMPTY_IMAGE");
  const fileName = safeFileName(asset, contentType);
  const blob = new Blob([bytes], { type: contentType });

  await saveCache(pageId, sourceUrl, {
    status: "pending",
    mime_type: contentType,
    file_name: fileName,
    upload_attempts: Number(existing?.upload_attempts || 0) + 1,
    last_error: null,
  });

  let lastError = null;
  for (const field of ["file", "files", "files[]"]) {
    try {
      const data = await uploadWithField(pageId, blob, fileName, field);
      const contentId = extractContentId(data);
      if (!contentId) throw new Error(`PANCAKE_UPLOAD_CONTENT_ID_MISSING:${JSON.stringify(data).slice(0, 500)}`);
      await saveCache(pageId, sourceUrl, {
        status: "ready",
        content_id: contentId,
        mime_type: contentType,
        file_name: fileName,
        last_error: null,
        uploaded_at: new Date().toISOString(),
      });
      await sleep(RATE_DELAY_MS);
      return contentId;
    } catch (error) {
      lastError = error;
      if (![400, 404, 415, 422].includes(Number(error?.status || 0))) break;
    }
  }
  await saveCache(pageId, sourceUrl, { status: "failed", last_error: String(lastError?.message || lastError).slice(0, 800) });
  throw lastError || new Error("PANCAKE_UPLOAD_FAILED");
}

export function v10PancakeNativeMediaReady() {
  return configured();
}

export async function sendPancakeNativeMedia({ pageId, recipientId, assets = [] } = {}) {
  if (!configured()) throw new Error("PANCAKE_NATIVE_MEDIA_NOT_CONFIGURED");
  if (!pageId || !recipientId || !Array.isArray(assets) || !assets.length) throw new Error("PANCAKE_NATIVE_MEDIA_INVALID_INPUT");
  const conversation = await lookupConversation(String(pageId), String(recipientId));
  const contentIds = [];
  for (const asset of assets.slice(0, 10)) {
    const id = await uploadAsset(String(pageId), asset);
    if (id && !contentIds.includes(id)) contentIds.push(id);
  }
  if (!contentIds.length) throw new Error("PANCAKE_NATIVE_MEDIA_NO_CONTENT_IDS");
  const url = `${PANCAKE_BASE}/api/public_api/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(conversation)}/messages?page_access_token=${encodeURIComponent(PANCAKE_TOKEN)}`;
  const data = await pancakeJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "reply_inbox", content_ids: contentIds }),
    timeout: 45000,
  });
  return {
    ...data,
    message_id: extractMessageId(data) || null,
    aiguka_transport: "pancake_native_media",
    pancake_conversation_id: conversation,
    content_ids: contentIds,
    media_count: contentIds.length,
  };
}

export const __private__ = { configured, lookupConversation, uploadAsset, extractContentId, deliveryUrl, senderIds };
