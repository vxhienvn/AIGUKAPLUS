import { loadActiveMetaConnection } from "./meta-token-store.js";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const WORKER_NAME = process.env.AIGUKA_OUTBOUND_WORKER_NAME || "aiguka-railway-outbound";
const WORKER_VERSION = "production_v1";
const POLL_MS = Math.max(2000, Number(process.env.AIGUKA_OUTBOUND_POLL_MS || 4000));
const VERIFY_MS = Math.max(60_000, Number(process.env.AIGUKA_PAGE_VERIFY_MS || 300_000));

let running = false;
let pageTokenCache = { expiresAt: 0, values: new Map() };

function configured() {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
}

async function request(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 30_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `SUPABASE_HTTP_${response.status}`);
  return data;
}

async function rest(path, options = {}) {
  return request(`/rest/v1/${path}`, options);
}

async function rpc(name, args = {}) {
  return request(`/rest/v1/rpc/${name}`, { method: "POST", body: args });
}

async function graph(path, token, options = {}) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${String(path).replace(/^\//, "")}`);
  url.searchParams.set("access_token", token);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeout || 30_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok || data?.error) {
    const error = new Error(data?.error?.message || `META_HTTP_${response.status}`);
    error.code = data?.error?.code;
    error.subcode = data?.error?.error_subcode;
    error.details = data?.error || data;
    throw error;
  }
  return data;
}

async function heartbeat(status = "healthy", lastError = null) {
  if (!configured()) return;
  await rest("v8_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: WORKER_NAME,
      worker_type: "outbound",
      worker_version: WORKER_VERSION,
      status,
      capabilities: {
        retry: true,
        dedupe: true,
        final_gate: true,
        two_phase_authorization: true,
        meta_transport: true,
        text: true,
        image: true,
        carousel: true,
        simulation_only: false,
        page_verification: true,
      },
      last_error: lastError ? String(lastError).slice(0, 500) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function fetchPageTokens(force = false) {
  if (!force && pageTokenCache.expiresAt > Date.now()) return pageTokenCache.values;
  const pages = await rest("v8_pages?select=page_id,page_name,token_secret_name&is_active=eq.true");
  const values = new Map();

  for (const page of pages || []) {
    const envToken = page.token_secret_name ? process.env[page.token_secret_name] : "";
    if (envToken) values.set(String(page.page_id), { token: envToken, name: page.page_name, source: "railway_secret" });
  }

  try {
    const connection = await loadActiveMetaConnection();
    if (connection?.accessToken) {
      let next = `me/accounts?fields=id,name,access_token,tasks&limit=200`;
      let count = 0;
      while (next && count++ < 10) {
        const data = await graph(next, connection.accessToken);
        for (const page of data.data || []) {
          if (page.id && page.access_token) values.set(String(page.id), { token: page.access_token, name: page.name, source: "oauth_page_token", tasks: page.tasks || [] });
        }
        next = data?.paging?.next ? data.paging.next.replace(`https://graph.facebook.com/${GRAPH_VERSION}/`, "") : "";
      }
    }
  } catch (error) {
    console.error("[AIGUKA outbound] Could not refresh Page tokens:", error.message);
  }

  pageTokenCache = { expiresAt: Date.now() + 5 * 60_000, values };
  return values;
}

async function pageToken(pageId) {
  const tokens = await fetchPageTokens();
  return tokens.get(String(pageId))?.token || "";
}

async function verifyOnePage(page) {
  const token = await pageToken(page.page_id);
  const now = new Date().toISOString();
  if (!token) {
    await rest(`v8_pages?page_id=eq.${encodeURIComponent(page.page_id)}`, {
      method: "PATCH",
      body: { connection_status: "token_missing", webhook_status: "unknown", last_connection_error: "PAGE_ACCESS_TOKEN_NOT_FOUND", updated_at: now },
    });
    await rest(`v8_page_messaging_capabilities?page_id=eq.${encodeURIComponent(page.page_id)}`, {
      method: "PATCH",
      body: { pages_messaging_status: "unknown", notes: "Không tìm thấy Page Access Token", updated_at: now },
    });
    return { page_id: page.page_id, ok: false, reason: "PAGE_ACCESS_TOKEN_NOT_FOUND" };
  }

  try {
    await graph(`${page.page_id}/conversations`, token, { query: { fields: "id,updated_time", limit: 1 } });

    let subscribed = await graph(`${page.page_id}/subscribed_apps`, token, { query: { fields: "id,name,subscribed_fields" } });
    const appId = String(process.env.META_APP_ID || "");
    let app = (subscribed.data || []).find((item) => !appId || String(item.id) === appId);
    const requiredFields = ["messages", "messaging_postbacks", "message_deliveries", "message_reads", "messaging_referrals"];
    const existingFields = new Set(app?.subscribed_fields || []);
    const missing = requiredFields.filter((field) => !existingFields.has(field));

    if (!app || missing.length) {
      await graph(`${page.page_id}/subscribed_apps`, token, {
        method: "POST",
        query: { subscribed_fields: requiredFields.join(",") },
      });
      subscribed = await graph(`${page.page_id}/subscribed_apps`, token, { query: { fields: "id,name,subscribed_fields" } });
      app = (subscribed.data || []).find((item) => !appId || String(item.id) === appId) || (subscribed.data || [])[0];
    }

    const fields = app?.subscribed_fields || requiredFields;
    await rest(`v8_pages?page_id=eq.${encodeURIComponent(page.page_id)}`, {
      method: "PATCH",
      body: {
        connection_status: "connected",
        webhook_status: "subscribed",
        subscribed_fields: fields,
        last_verified_at: now,
        last_connection_error: null,
        updated_at: now,
      },
    });
    await rest(`v8_page_messaging_capabilities?page_id=eq.${encodeURIComponent(page.page_id)}`, {
      method: "PATCH",
      body: {
        pages_messaging_status: "active",
        notes: "Page token, conversations và subscribed_apps đã xác minh bởi Railway outbound worker",
        updated_at: now,
      },
    });
    return { page_id: page.page_id, ok: true, fields };
  } catch (error) {
    await rest(`v8_pages?page_id=eq.${encodeURIComponent(page.page_id)}`, {
      method: "PATCH",
      body: { connection_status: "error", webhook_status: "error", last_connection_error: String(error.message).slice(0, 500), updated_at: now },
    }).catch(() => {});
    await rest(`v8_page_messaging_capabilities?page_id=eq.${encodeURIComponent(page.page_id)}`, {
      method: "PATCH",
      body: { pages_messaging_status: "error", notes: String(error.message).slice(0, 500), updated_at: now },
    }).catch(() => {});
    return { page_id: page.page_id, ok: false, reason: error.message };
  }
}

async function verifyPages() {
  if (!configured()) return [];
  pageTokenCache.expiresAt = 0;
  const pages = await rest("v8_pages?select=page_id,page_name,token_secret_name&is_active=eq.true&order=page_name.asc");
  const results = [];
  for (const page of pages || []) results.push(await verifyOnePage(page));
  return results;
}

function buildMetaMessage(item) {
  const payload = item.payload || {};
  if (payload.message && typeof payload.message === "object") return payload.message;
  if (item.message_type === "text") {
    const text = String(payload.text || "").trim();
    if (!text) throw new Error("EMPTY_TEXT_PAYLOAD");
    return { text };
  }
  if (["carousel", "generic_template", "template"].includes(item.message_type) || Array.isArray(payload.elements)) {
    const elements = Array.isArray(payload.elements) ? payload.elements.slice(0, 10) : [];
    if (!elements.length) throw new Error("EMPTY_CAROUSEL_PAYLOAD");
    return { attachment: { type: "template", payload: { template_type: "generic", elements } } };
  }
  if (item.message_type === "image") {
    const url = String(payload.url || payload.image_url || "").trim();
    if (!url) throw new Error("EMPTY_IMAGE_URL");
    return { attachment: { type: "image", payload: { url, is_reusable: true } } };
  }
  if (payload.attachment) return { attachment: payload.attachment };
  throw new Error(`UNSUPPORTED_MESSAGE_TYPE_${item.message_type}`);
}

async function sendMeta(item) {
  const token = await pageToken(item.page_id);
  if (!token) throw new Error(`PAGE_ACCESS_TOKEN_NOT_FOUND_${item.page_id}`);
  const message = buildMetaMessage(item);
  return graph(`${item.page_id}/messages`, token, {
    method: "POST",
    body: {
      recipient: { id: String(item.sender_id) },
      messaging_type: "RESPONSE",
      message,
    },
  });
}

async function processItem(item) {
  try {
    const authorization = await rpc("v8_authorize_outbound_send", { p_outbound_id: item.id, p_worker_name: WORKER_NAME });
    if (!authorization?.allowed) return;
    const confirmation = await rpc("v8_confirm_outbound_transport", { p_outbound_id: item.id, p_worker_name: WORKER_NAME });
    if (!confirmation?.allowed) return;
    const result = await sendMeta({ ...item, payload: confirmation.payload || item.payload, message_type: confirmation.message_type || item.message_type });
    await rpc("v8_complete_outbound", { p_outbound_id: item.id, p_worker_name: WORKER_NAME, p_external_message_id: result.message_id || null });
  } catch (error) {
    console.error(`[AIGUKA outbound] ${item.id}:`, error.message);
    await rpc("v8_fail_outbound", { p_outbound_id: item.id, p_worker_name: WORKER_NAME, p_error: String(error.message).slice(0, 500), p_retry_seconds: 30 }).catch(() => {});
  }
}

async function poll() {
  if (!configured() || running) return;
  running = true;
  try {
    await heartbeat("healthy", null);
    const claimed = await rpc("v8_claim_outbound_batch", { p_worker_name: WORKER_NAME, p_batch_size: 10 });
    for (const item of Array.isArray(claimed) ? claimed : []) await processItem(item);
    await heartbeat("healthy", null);
  } catch (error) {
    console.error("[AIGUKA outbound worker]", error.message);
    await heartbeat("degraded", error.message).catch(() => {});
  } finally {
    running = false;
  }
}

export async function startOutboundWorker() {
  if (!configured()) {
    console.warn("[AIGUKA outbound] Supabase service configuration missing; worker not started");
    return;
  }
  await heartbeat("starting", null).catch(() => {});
  const verification = await verifyPages().catch((error) => [{ ok: false, reason: error.message }]);
  console.log("[AIGUKA outbound] Page verification:", verification);
  await poll();
  setInterval(() => { poll().catch(() => {}); }, POLL_MS).unref?.();
  setInterval(() => { verifyPages().catch((error) => console.error("[AIGUKA outbound verify]", error.message)); }, VERIFY_MS).unref?.();
  console.log(`[AIGUKA outbound] Worker ${WORKER_NAME} started; poll ${POLL_MS}ms`);
}

await startOutboundWorker();
