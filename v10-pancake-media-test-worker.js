import { sendPancakeNativeMedia, v10PancakeNativeMediaReady } from "./v10-pancake-native-media.js";

const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").trim().replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "").trim();
const NAME = "aiguka-v10-pancake-media-test";
const VERSION = "v10_pancake_media_test_v1";
const POLL_MS = 4000;
let running = false;
let timer;

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

async function heartbeat(status, details = {}, error = null) {
  if (!CORE_BASE || !CORE_KEY) return;
  const now = new Date().toISOString();
  await core("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: NAME,
      worker_version: VERSION,
      status,
      mode: v10PancakeNativeMediaReady() ? "ACTIVE" : "OFF",
      details,
      last_error: error ? String(error).slice(0, 800) : null,
      last_seen_at: now,
      updated_at: now,
    },
  }).catch(() => {});
}

async function nextJob() {
  const rows = await core(`v9_jobs?select=*&job_type=eq.pancake_media_test&status=eq.queued&run_after=lte.${encodeURIComponent(new Date().toISOString())}&order=created_at.asc&limit=1`, { timeout: 12000 });
  return rows?.[0] || null;
}

async function claim(job) {
  const rows = await core(`v9_jobs?id=eq.${job.id}&status=eq.queued`, {
    method: "PATCH",
    prefer: "return=representation",
    body: { status: "processing", attempts: Number(job.attempts || 0) + 1, locked_by: NAME, locked_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  });
  return rows?.[0] || null;
}

async function assetsFor(job) {
  const direct = Array.isArray(job?.payload?.assets) ? job.payload.assets : [];
  if (direct.length) return direct.slice(0, Math.max(1, Math.min(10, Number(job?.payload?.limit || 10))));
  const bundleId = String(job?.payload?.delivery_bundle_id || "").trim();
  if (!bundleId) throw new Error("PANCAKE_TEST_ASSETS_OR_BUNDLE_REQUIRED");
  const rows = await core(`v9_delivery_bundles?select=asset_refs&id=eq.${encodeURIComponent(bundleId)}&limit=1`, { timeout: 12000 });
  const refs = Array.isArray(rows?.[0]?.asset_refs) ? rows[0].asset_refs : [];
  if (!refs.length) throw new Error("PANCAKE_TEST_BUNDLE_HAS_NO_ASSETS");
  return refs.slice(0, Math.max(1, Math.min(10, Number(job?.payload?.limit || 10))));
}

async function complete(job, result) {
  const now = new Date().toISOString();
  await core(`v9_jobs?id=eq.${job.id}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: { status: "completed", result, last_error: null, completed_at: now, locked_by: null, locked_at: null, updated_at: now },
  });
}

async function fail(job, error) {
  const now = new Date().toISOString();
  await core(`v9_jobs?id=eq.${job.id}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: { status: "dead_letter", last_error: String(error?.message || error).slice(0, 1200), completed_at: now, locked_by: null, locked_at: null, updated_at: now },
  }).catch(() => {});
}

async function tick() {
  if (running || !CORE_BASE || !CORE_KEY || !v10PancakeNativeMediaReady()) return;
  running = true;
  try {
    const job = await nextJob();
    if (!job) {
      await heartbeat("healthy", { waiting: true });
      return;
    }
    const claimed = await claim(job);
    if (!claimed) return;
    try {
      const assets = await assetsFor(claimed);
      const result = await sendPancakeNativeMedia({ pageId: claimed.page_id, recipientId: claimed.sender_id, assets });
      await complete(claimed, { transport: "pancake_native_media", media_count: result.media_count, content_ids: result.content_ids, pancake_conversation_id: result.pancake_conversation_id, provider_message_id: result.message_id || null });
      await heartbeat("healthy", { last_job_id: claimed.id, media_count: result.media_count, conversation_id: result.pancake_conversation_id });
    } catch (error) {
      await fail(claimed, error);
      await heartbeat("degraded", { last_job_id: claimed.id }, error?.message || error);
    }
  } catch (error) {
    await heartbeat("degraded", {}, error?.message || error);
  } finally {
    running = false;
  }
}

if (!CORE_BASE || !CORE_KEY || !v10PancakeNativeMediaReady()) {
  console.warn("[AIGUKA V10 Pancake media test] disabled: Core or Pancake token missing");
  heartbeat("idle", { configured: false }, "PANCAKE_NATIVE_MEDIA_NOT_CONFIGURED").catch(() => {});
} else {
  console.log(`[AIGUKA V10 Pancake media test] ${VERSION} started`);
  tick().catch(() => {});
  timer = setInterval(() => tick().catch(() => {}), POLL_MS);
  timer.unref?.();
}
