import { loadActiveMetaConnection } from "./meta-token-store.js";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const WORKER_NAME = process.env.AIGUKA_META_PROFILE_SYNC_WORKER_NAME || "aiguka-railway-meta-profile-sync";
const WORKER_VERSION = "oauth_unified_sync_v1";
const POLL_MS = Math.max(3000, Number(process.env.AIGUKA_META_PROFILE_SYNC_POLL_MS || 5000));

let running = false;
let pageTokenCache = { expiresAt: 0, values: new Map() };
const inFlight = new Map();

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
    signal: AbortSignal.timeout(options.timeout || 120_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || data?.hint || `SUPABASE_HTTP_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const rest = (path, options = {}) => request(`/rest/v1/${path}`, options);
const rpc = (name, body = {}) => request(`/rest/v1/rpc/${name}`, { method: "POST", body });

async function graph(path, token, query = {}) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${String(path).replace(/^\//, "")}`);
  url.searchParams.set("access_token", token);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), cache: "no-store" });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok || data?.error) {
    const error = new Error(data?.error?.message || `META_HTTP_${response.status}`);
    error.code = data?.error?.code;
    error.subcode = data?.error?.error_subcode;
    throw error;
  }
  return data;
}

async function fetchPageTokens(force = false) {
  if (!force && pageTokenCache.expiresAt > Date.now()) return pageTokenCache.values;
  const values = new Map();
  const connection = await loadActiveMetaConnection();
  if (!connection?.accessToken) throw new Error("META_OAUTH_CONNECTION_NOT_AVAILABLE");
  let next = "me/accounts?fields=id,name,access_token,tasks&limit=200";
  let pages = 0;
  while (next && pages++ < 10) {
    const data = await graph(next, connection.accessToken);
    for (const page of data.data || []) {
      if (page.id && page.access_token) values.set(String(page.id), { token: page.access_token, name: page.name, tasks: page.tasks || [] });
    }
    next = data?.paging?.next ? data.paging.next.replace(`https://graph.facebook.com/${GRAPH_VERSION}/`, "") : "";
  }
  pageTokenCache = { expiresAt: Date.now() + 5 * 60_000, values };
  return values;
}

async function pageToken(pageId) {
  let tokens = await fetchPageTokens();
  let row = tokens.get(String(pageId));
  if (!row) {
    pageTokenCache.expiresAt = 0;
    tokens = await fetchPageTokens(true);
    row = tokens.get(String(pageId));
  }
  if (!row?.token) throw new Error(`OAUTH_PAGE_TOKEN_NOT_FOUND_${pageId}`);
  return row.token;
}

async function findConversation(pageId, senderId, token) {
  try {
    const direct = await graph(`${pageId}/conversations`, token, {
      platform: "messenger", user_id: senderId, fields: "id,updated_time,participants", limit: 10,
    });
    if (direct.data?.[0]) return direct.data[0];
  } catch (error) {
    if (Number(error.code) !== 100) throw error;
  }

  let next = `${pageId}/conversations?platform=messenger&fields=id,updated_time,participants&limit=100`;
  for (let page = 0; next && page < 10; page += 1) {
    const data = await graph(next, token);
    for (const conversation of data.data || []) {
      if ((conversation.participants?.data || []).some((participant) => String(participant.id) === String(senderId))) return conversation;
    }
    next = data?.paging?.next ? data.paging.next.replace(`https://graph.facebook.com/${GRAPH_VERSION}/`, "") : "";
  }
  return null;
}

async function fetchProfile(senderId, token, participantName = null) {
  let profile = {};
  let genderAvailable = true;
  try {
    profile = await graph(senderId, token, { fields: "first_name,last_name,profile_pic,locale,gender" });
  } catch {
    genderAvailable = false;
    try {
      profile = await graph(senderId, token, { fields: "first_name,last_name,profile_pic,locale" });
    } catch {
      profile = {};
    }
  }
  if (!profile.first_name && !profile.last_name && participantName) {
    const parts = String(participantName).trim().split(/\s+/).filter(Boolean);
    profile.first_name = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0] || null;
    profile.last_name = parts.length > 1 ? parts.at(-1) : null;
  }
  return { profile, genderAvailable };
}

async function fetchMessages(conversationId, token) {
  const messages = [];
  let next = `${conversationId}/messages?fields=id,message,created_time,from,to,attachments&limit=100`;
  for (let page = 0; next && page < 10; page += 1) {
    const data = await graph(next, token);
    messages.push(...(data.data || []));
    next = data?.paging?.next ? data.paging.next.replace(`https://graph.facebook.com/${GRAPH_VERSION}/`, "") : "";
  }
  return messages;
}

async function doSync(pageId, senderId, options = {}) {
  const token = await pageToken(pageId);
  const conversation = await findConversation(pageId, senderId, token);
  const participant = (conversation?.participants?.data || []).find((item) => String(item.id) === String(senderId));
  const profileResult = await fetchProfile(senderId, token, participant?.name || null);
  const profile = await rpc("v8_admin_upsert_profile", {
    p_page_id: String(pageId),
    p_sender_id: String(senderId),
    p_profile: profileResult.profile,
    p_gender_available: profileResult.genderAvailable,
  });

  if (options.profileOnly) {
    return { ok: true, profile, conversation_found: Boolean(conversation), messages_fetched: 0 };
  }
  if (!conversation?.id) throw new Error("META_CONVERSATION_NOT_FOUND");
  const messages = await fetchMessages(conversation.id, token);
  const history = await rpc("v8_admin_upsert_history", {
    p_page_id: String(pageId),
    p_sender_id: String(senderId),
    p_conversation_id: String(conversation.id),
    p_messages: messages,
    p_participant_name: participant?.name || null,
  });
  return { ok: true, profile, history, conversation_id: conversation.id, messages_fetched: messages.length };
}

export async function syncCustomerNow(pageId, senderId, options = {}) {
  const key = `${pageId}:${senderId}:${options.profileOnly ? "profile" : "history"}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = doSync(pageId, senderId, options).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function heartbeat(status = "healthy", lastError = null, details = {}) {
  if (!configured()) return;
  await rest("v8_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: WORKER_NAME,
      worker_type: "meta_profile_sync",
      worker_version: WORKER_VERSION,
      status,
      capabilities: { oauth_page_tokens: true, profile: true, conversation_history: true, unified_token_source: true, truthful_item_health: true, ...details },
      last_error: lastError ? String(lastError).slice(0, 500) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function processQueueItem(item) {
  try {
    await syncCustomerNow(item.page_id, item.sender_id);
    await rpc("v8_finish_conversation_sync", { p_id: item.id, p_worker: WORKER_NAME, p_success: true, p_error: null }).catch(() => {});
    return true;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 900);
    console.error(`[AIGUKA Meta profile sync] ${item.page_id}/${item.sender_id}:`, message);
    await rpc("v8_finish_conversation_sync", { p_id: item.id, p_worker: WORKER_NAME, p_success: false, p_error: message }).catch(() => {});
    return false;
  }
}

async function poll() {
  if (!configured() || running) return;
  running = true;
  try {
    const claimed = await rpc("v8_claim_conversation_sync_batch", { p_worker: WORKER_NAME, p_batch_size: 4 });
    let failures = 0;
    for (const item of Array.isArray(claimed) ? claimed : []) {
      if (!await processQueueItem(item)) failures += 1;
    }
    if (failures) await heartbeat("degraded", `${failures}/${claimed.length} sync item(s) failed`);
    else await heartbeat("healthy", null, { last_batch_size: Array.isArray(claimed) ? claimed.length : 0 });
  } catch (error) {
    await heartbeat("degraded", String(error?.message || error)).catch(() => {});
  } finally {
    running = false;
  }
}

export async function startMetaProfileSyncWorker() {
  if (!configured()) {
    console.warn("[AIGUKA Meta profile sync] Supabase service configuration missing; worker not started");
    return;
  }
  await heartbeat("starting").catch(() => {});
  await poll();
  setInterval(() => { poll().catch(() => {}); }, POLL_MS).unref?.();
  console.log(`[AIGUKA Meta profile sync] Worker ${WORKER_NAME} started; poll ${POLL_MS}ms`);
}

await startMetaProfileSyncWorker();