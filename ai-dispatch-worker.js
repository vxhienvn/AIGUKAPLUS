const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const WORKER_NAME = process.env.AIGUKA_AI_DISPATCH_WORKER_NAME || "aiguka-railway-ai-dispatch";
const WORKER_VERSION = "profile_preflight_v1";
const POLL_MS = Math.max(1000, Number(process.env.AIGUKA_AI_DISPATCH_POLL_MS || 1200));

let running = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const placeholderName = (value) => {
  const name = String(value || "").trim();
  return !name || /^(khách|customer)\s*\d*$/i.test(name);
};

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
    signal: AbortSignal.timeout(options.timeout || 90_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || data?.hint || `HTTP_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const rpc = (name, body = {}) => request(`/rest/v1/rpc/${name}`, { method: "POST", body });
const rest = (path, options = {}) => request(`/rest/v1/${path}`, options);

async function heartbeat(status = "healthy", lastError = null) {
  await rest("v8_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: WORKER_NAME,
      worker_type: "ai_dispatch",
      worker_version: WORKER_VERSION,
      status,
      capabilities: {
        profile_sync_preflight: true,
        meta_signed_sync: true,
        ai_brain_dispatch: true,
        decision_revision_gate: true,
      },
      last_error: lastError ? String(lastError).slice(0, 500) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

async function readCustomer(pageId, senderId) {
  const rows = await rest(
    `v8_customers?select=id,display_name,gender,gender_source,preferred_salutation,profile_sync_status&page_id=eq.${encodeURIComponent(pageId)}&sender_id=eq.${encodeURIComponent(senderId)}&limit=1`,
  );
  return rows?.[0] || null;
}

async function ensureProfile(item) {
  let customer = await readCustomer(item.page_id, item.sender_id);
  const needsSync = !customer || placeholderName(customer.display_name)
    || ["deferred_on_demand", "error", "empty_profile"].includes(String(customer.profile_sync_status || ""));
  if (!needsSync) return { attempted: false, customer };

  await rpc("v8_dispatch_single_customer_profile_sync", {
    p_page_id: item.page_id,
    p_sender_id: item.sender_id,
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(400);
    customer = await readCustomer(item.page_id, item.sender_id);
    if (customer && !placeholderName(customer.display_name)) break;
  }
  return { attempted: true, customer };
}

async function dispatchBrain(item) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/aiguka-v8-ai-brain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: item.id }),
    signal: AbortSignal.timeout(90_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok && response.status !== 409) {
    throw new Error(data?.error || `AI_BRAIN_HTTP_${response.status}`);
  }
  return data;
}

async function processItem(item) {
  try {
    const profile = await ensureProfile(item);
    const result = await dispatchBrain(item);
    await rpc("v8_finish_ai_dispatch", {
      p_request_id: item.id,
      p_worker: WORKER_NAME,
      p_success: true,
      p_error: null,
      p_details: {
        profile_sync_attempted: profile.attempted,
        display_name: profile.customer?.display_name || null,
        gender: profile.customer?.gender || null,
        preferred_salutation: profile.customer?.preferred_salutation || null,
        brain_result: result?.ok ?? true,
      },
    }).catch(() => {});
  } catch (error) {
    const message = String(error?.message || error).slice(0, 800);
    console.error(`[AIGUKA AI dispatch] ${item.id}:`, message);
    await rpc("v8_finish_ai_dispatch", {
      p_request_id: item.id,
      p_worker: WORKER_NAME,
      p_success: false,
      p_error: message,
      p_details: {},
    }).catch(() => {});
  }
}

async function poll() {
  if (!configured() || running) return;
  running = true;
  try {
    await heartbeat("healthy", null);
    const claimed = await rpc("v8_claim_ai_dispatch_batch", {
      p_worker: WORKER_NAME,
      p_batch_size: 5,
    });
    for (const item of Array.isArray(claimed) ? claimed : []) await processItem(item);
    await heartbeat("healthy", null);
  } catch (error) {
    const message = String(error?.message || error);
    if (!message.includes("v8_claim_ai_dispatch_batch")) {
      console.error("[AIGUKA AI dispatch worker]", message);
    }
    await heartbeat("degraded", message).catch(() => {});
  } finally {
    running = false;
  }
}

export async function startAiDispatchWorker() {
  if (!configured()) {
    console.warn("[AIGUKA AI dispatch] Supabase service configuration missing; worker not started");
    return;
  }
  await heartbeat("starting", null).catch(() => {});
  await poll();
  setInterval(() => { poll().catch(() => {}); }, POLL_MS).unref?.();
  console.log(`[AIGUKA AI dispatch] Worker ${WORKER_NAME} started; poll ${POLL_MS}ms`);
}

await startAiDispatchWorker();
