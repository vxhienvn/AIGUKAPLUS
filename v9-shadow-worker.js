import { normalizeV8MetaEvent } from "./v9/core/event-normalizer.js";
import { detectContact } from "./v9/core/contact-detector.js";
import { reduceConversationState } from "./v9/core/state-machine.js";

const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "").replace(/\/$/, "");
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const WORKER_NAME = "aiguka-v9-shadow";
const WORKER_VERSION = "v9_foundation_shadow_v1";
const POLL_MS = Math.max(3_000, Number(process.env.AIGUKA_V9_POLL_MS || 5_000));
const OFF_POLL_MS = Math.max(30_000, Number(process.env.AIGUKA_V9_OFF_POLL_MS || 30_000));
const BATCH_SIZE = Math.min(50, Math.max(1, Number(process.env.AIGUKA_V9_BATCH_SIZE || 10)));
const HEARTBEAT_MS = 30_000;

let timer = null;
let running = false;
let lastHeartbeatAt = 0;

function configured() {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}

async function request(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 20_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || data?.hint || `SUPABASE_HTTP_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const rest = (path, options = {}) => request(`/rest/v1/${path}`, options);

function schedule(delay) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => tick().catch(() => {}), delay);
  timer.unref?.();
}

async function loadRuntime() {
  const rows = await rest("v9_runtime_config?select=id,mode,debounce_seconds,response_sla_seconds,event_batch_size&id=eq.1&limit=1", { timeout: 8_000 });
  return rows?.[0] || { mode: "OFF", debounce_seconds: 20, response_sla_seconds: 90, event_batch_size: BATCH_SIZE };
}

async function loadCursor() {
  const rows = await rest(`v9_worker_cursors?select=cursor_created_at,cursor_id&worker_name=eq.${encodeURIComponent(WORKER_NAME)}&limit=1`);
  return rows?.[0] || { cursor_created_at: new Date().toISOString(), cursor_id: null };
}

function isAfterCursor(row, cursor) {
  const rowTime = Date.parse(row.created_at || 0);
  const cursorTime = Date.parse(cursor.cursor_created_at || 0);
  if (rowTime > cursorTime) return true;
  if (rowTime < cursorTime) return false;
  return String(row.id || "") > String(cursor.cursor_id || "");
}

async function fetchSourceEvents(cursor, limit) {
  const after = encodeURIComponent(cursor.cursor_created_at || new Date().toISOString());
  const select = "id,page_id,sender_id,recipient_id,message_id,message_text,timestamp_ms,event_time,referral,attachments,raw_payload,created_at";
  const rows = await rest(`v8_meta_events?select=${select}&created_at=gte.${after}&order=created_at.asc,id.asc&limit=${Math.max(limit * 3, 30)}`, { timeout: 20_000 });
  return (rows || []).filter((row) => isAfterCursor(row, cursor)).slice(0, limit);
}

async function saveCursor(row) {
  await rest("v9_worker_cursors?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: WORKER_NAME,
      cursor_created_at: row.created_at,
      cursor_id: row.id,
      updated_at: new Date().toISOString(),
    },
  });
}

async function readConversation(pageId, senderId) {
  const rows = await rest(`v9_conversation_state?select=*&page_id=eq.${encodeURIComponent(pageId)}&sender_id=eq.${encodeURIComponent(senderId)}&limit=1`);
  return rows?.[0] || null;
}

async function writeConversation(event, next) {
  await rest("v9_conversation_state?on_conflict=page_id,sender_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      page_id: event.pageId,
      sender_id: event.senderId,
      state: next.state,
      version: next.version,
      contact_status: next.contactStatus || "missing",
      phone: next.phone || null,
      zalo: next.zalo || null,
      human_takeover: Boolean(next.humanTakeover),
      last_customer_event_at: next.lastCustomerEventAt || null,
      last_page_event_at: next.lastPageEventAt || null,
      response_deadline_at: next.responseDeadlineAt || null,
      last_source_event_id: event.sourceEventId,
      updated_at: next.updatedAt,
    },
  });
}

async function persistCanonicalEvent(event) {
  const rows = await rest("v9_events?on_conflict=source_event_id", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: {
      source_system: event.sourceSystem,
      source_event_id: event.sourceEventId,
      page_id: event.pageId,
      sender_id: event.senderId,
      recipient_id: event.recipientId,
      message_id: event.messageId,
      actor_type: event.actorType,
      actor_evidence: event.actorEvidence,
      event_type: event.eventType,
      message_text: event.text,
      attachments: event.attachments,
      referral: event.referral,
      occurred_at: event.occurredAt,
      received_at: event.receivedAt,
      payload: event.payload,
    },
  });
  return rows?.[0] || null;
}

async function createShadowArtifacts(event, canonicalRow, contact, next, runtime) {
  if (!canonicalRow || event.actorType !== "customer") return;
  const now = new Date();
  const deadline = contact.contactCaptured
    ? null
    : new Date(now.getTime() + Number(runtime.response_sla_seconds || 90) * 1000).toISOString();

  await rest("v9_sla_events?on_conflict=source_event_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      source_event_id: event.sourceEventId,
      page_id: event.pageId,
      sender_id: event.senderId,
      deadline_at: deadline || now.toISOString(),
      status: contact.contactCaptured ? "resolved" : "open",
      resolution: contact.contactCaptured ? "contact_captured" : null,
      resolved_at: contact.contactCaptured ? now.toISOString() : null,
      updated_at: now.toISOString(),
    },
  });

  await rest("v9_shadow_observations?on_conflict=source_event_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      source_event_id: event.sourceEventId,
      page_id: event.pageId,
      sender_id: event.senderId,
      actor_type: event.actorType,
      event_type: event.eventType,
      contact_detection: contact,
      state_after: next.state,
      goal: "capture_phone_or_zalo",
      created_at: now.toISOString(),
    },
  });

  if (!contact.contactCaptured && ["customer_message", "customer_postback"].includes(event.eventType)) {
    await rest("v9_jobs?on_conflict=source_event_id,job_type", {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=minimal",
      body: {
        source_event_id: event.sourceEventId,
        event_id: canonicalRow.id,
        job_type: "decision_shadow",
        page_id: event.pageId,
        sender_id: event.senderId,
        status: "queued",
        run_after: new Date(now.getTime() + Number(runtime.debounce_seconds || 20) * 1000).toISOString(),
        payload: { goal: "capture_phone_or_zalo", mode: "SHADOW" },
      },
    });
  }
}

async function processSourceRow(row, runtime) {
  const event = normalizeV8MetaEvent(row);
  const canonicalRow = await persistCanonicalEvent(event);
  if (!event.pageId || !event.senderId) return;

  const currentRow = await readConversation(event.pageId, event.senderId);
  const current = currentRow ? {
    state: currentRow.state,
    version: currentRow.version,
    contactStatus: currentRow.contact_status,
    phone: currentRow.phone,
    zalo: currentRow.zalo,
    humanTakeover: currentRow.human_takeover,
    lastCustomerEventAt: currentRow.last_customer_event_at,
    lastPageEventAt: currentRow.last_page_event_at,
    responseDeadlineAt: currentRow.response_deadline_at,
  } : null;
  const contact = event.actorType === "customer" ? detectContact(event.text) : detectContact("");
  const next = reduceConversationState(current, event, contact, {
    slaSeconds: runtime.response_sla_seconds,
    now: new Date(),
  });
  await writeConversation(event, next);
  await createShadowArtifacts(event, canonicalRow, contact, next, runtime);
}

async function processDueJobs(runtime) {
  const now = new Date().toISOString();
  const jobs = await rest(`v9_jobs?select=*&status=eq.queued&run_after=lte.${encodeURIComponent(now)}&order=run_after.asc&limit=5`);
  let completed = 0;
  for (const job of jobs || []) {
    await rest(`v9_jobs?id=eq.${encodeURIComponent(job.id)}&status=eq.queued`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        status: "processing",
        locked_by: WORKER_NAME,
        locked_at: now,
        attempts: Number(job.attempts || 0) + 1,
        updated_at: now,
      },
    });

    try {
      const events = await rest(`v9_events?select=id,source_event_id,actor_type,event_type,message_text,occurred_at&page_id=eq.${encodeURIComponent(job.page_id)}&sender_id=eq.${encodeURIComponent(job.sender_id)}&order=occurred_at.desc&limit=12`);
      const customerRows = await rest(`v8_customers?select=display_name,phone,zalo,gender,gender_source,preferred_salutation,last_product_key,last_intent_type&page_id=eq.${encodeURIComponent(job.page_id)}&sender_id=eq.${encodeURIComponent(job.sender_id)}&limit=1`).catch(() => []);
      const customer = customerRows?.[0] || null;
      const existingContact = Boolean(customer?.phone || customer?.zalo);
      const action = existingContact ? "contact_already_captured" : "needs_ai_decision";

      await rest("v9_decisions?on_conflict=source_event_id", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          source_event_id: job.source_event_id,
          page_id: job.page_id,
          sender_id: job.sender_id,
          mode: String(runtime.mode || "SHADOW"),
          status: "shadow_ready",
          goal: "capture_phone_or_zalo",
          action,
          confidence: existingContact ? 1 : 0,
          input_snapshot: {
            recent_events: [...(events || [])].reverse(),
            customer,
            response_sla_seconds: runtime.response_sla_seconds,
          },
          output: {
            should_send: false,
            reason: "V9 shadow foundation records context but cannot send customer messages.",
          },
          updated_at: new Date().toISOString(),
        },
      });

      await rest(`v9_jobs?id=eq.${encodeURIComponent(job.id)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: { status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      });
      completed += 1;
    } catch (error) {
      const attempts = Number(job.attempts || 0) + 1;
      await rest(`v9_jobs?id=eq.${encodeURIComponent(job.id)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: {
          status: attempts >= 5 ? "dead_letter" : "queued",
          run_after: new Date(Date.now() + Math.min(300_000, attempts * 30_000)).toISOString(),
          last_error: String(error?.message || error).slice(0, 800),
          updated_at: new Date().toISOString(),
        },
      }).catch(() => {});
    }
  }
  return completed;
}

async function markBreachedSla() {
  const now = new Date().toISOString();
  const rows = await rest(`v9_sla_events?select=id&status=eq.open&deadline_at=lte.${encodeURIComponent(now)}&limit=50`);
  for (const row of rows || []) {
    await rest(`v9_sla_events?id=eq.${encodeURIComponent(row.id)}&status=eq.open`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: { status: "breached", updated_at: now },
    });
  }
  return rows?.length || 0;
}

async function heartbeat(status, details = {}, lastError = null) {
  if (Date.now() - lastHeartbeatAt < HEARTBEAT_MS && status === "healthy") return;
  await rest("v9_worker_heartbeats?on_conflict=worker_name", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_name: WORKER_NAME,
      worker_version: WORKER_VERSION,
      status,
      mode: details.mode || null,
      details,
      last_error: lastError ? String(lastError).slice(0, 800) : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
  lastHeartbeatAt = Date.now();
}

async function tick() {
  if (!configured() || running) {
    schedule(OFF_POLL_MS);
    return;
  }
  running = true;
  let mode = "OFF";
  try {
    const runtime = await loadRuntime();
    mode = String(runtime.mode || "OFF").toUpperCase();
    if (mode === "OFF") {
      await heartbeat("idle", { mode });
      return;
    }
    if (mode !== "SHADOW") throw new Error(`V9_MODE_NOT_ALLOWED_FOR_FOUNDATION:${mode}`);

    const cursor = await loadCursor();
    const rows = await fetchSourceEvents(cursor, Math.min(Number(runtime.event_batch_size || BATCH_SIZE), BATCH_SIZE));
    let processed = 0;
    for (const row of rows) {
      await processSourceRow(row, runtime);
      await saveCursor(row);
      processed += 1;
    }
    const jobsCompleted = await processDueJobs(runtime);
    const slaBreached = await markBreachedSla();
    await heartbeat("healthy", { mode, processed, jobs_completed: jobsCompleted, sla_breached: slaBreached });
  } catch (error) {
    const message = String(error?.message || error);
    console.error("[AIGUKA V9 shadow]", message);
    await heartbeat("degraded", { mode }, message).catch(() => {});
  } finally {
    running = false;
    schedule(mode === "OFF" ? OFF_POLL_MS : POLL_MS);
  }
}

if (!configured()) {
  console.warn("[AIGUKA V9 shadow] Supabase configuration missing; worker disabled");
} else {
  schedule(2_000);
  console.log(`[AIGUKA V9 shadow] Foundation worker started; poll=${POLL_MS}ms`);
}
