import crypto from "node:crypto";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const WORKER_NAME = process.env.AIGUKA_AI_DISPATCH_WORKER_NAME || "aiguka-railway-ai-dispatch";
const WORKER_VERSION = "profile_preflight_v6_dynamic_follow_up_slide_recovery";
const POLL_MS = Math.max(1000, Number(process.env.AIGUKA_AI_DISPATCH_POLL_MS || 1200));
const FOLLOW_UP_SCAN_MS = Math.max(60_000, Number(process.env.AIGUKA_FOLLOW_UP_SCAN_MS || 120_000));

let running = false;
let lastFollowUpScanAt = 0;
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

async function heartbeat(status = "healthy", lastError = null, details = {}) {
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
        ai_brain_authenticated: true,
        decision_revision_gate: true,
        truthful_item_health: true,
        ai_follow_up_router: true,
        ai_follow_up_scheduler: true,
        follow_up_dynamic_governance: true,
        follow_up_requested_slide_recovery: true,
        ...details,
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
  if (!needsSync) return { attempted: false, ready: true, customer };

  await rpc("v8_dispatch_single_customer_profile_sync", {
    p_page_id: item.page_id,
    p_sender_id: item.sender_id,
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(400);
    customer = await readCustomer(item.page_id, item.sender_id);
    if (customer && !placeholderName(customer.display_name)) break;
  }
  return { attempted: true, ready: Boolean(customer && !placeholderName(customer.display_name)), customer };
}

function decryptProviderKey(value) {
  const [ivPart, tagPart, dataPart] = String(value || "").split(".");
  if (!ivPart || !tagPart || !dataPart) throw new Error("AI_PROVIDER_KEY_FORMAT_INVALID");
  const encryptionKey = crypto.createHash("sha256")
    .update(`${SERVICE_ROLE_KEY}|${SUPABASE_URL}|AIGUKA_AI_PROVIDER_KEYS_V1`)
    .digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8");
}

function parseFollowUpDecision(payload) {
  for (const output of payload?.output || []) {
    if (output?.type !== "function_call" || output?.name !== "submit_follow_up_decision") continue;
    return JSON.parse(output.arguments || "{}");
  }
  throw new Error("MODEL_DID_NOT_SUBMIT_FOLLOW_UP_DECISION");
}

async function loadFollowUpGovernance(pageId) {
  const [contexts, branches, lessons] = await Promise.all([
    rest("v8_ai_contexts?select=context_key,context_name,page_id,content,priority,metadata&is_active=eq.true&usage_mode=eq.PRODUCTION&order=priority.asc&limit=20"),
    rest("v8_prompt_branches?select=branch_key,branch_name,instruction_text,conditions,priority&is_active=eq.true&order=priority.asc&limit=40"),
    rest("v8_behavior_learning_cases?select=customer_message,improved_reply,context_summary,learning_scope,learning_type,reason,metadata,updated_at&status=in.(approved,applied)&order=updated_at.desc&limit=20"),
  ]);
  return {
    role: "advisory_reference_ai_decides",
    contexts: (contexts || []).filter((x) => !x.page_id || String(x.page_id) === String(pageId)),
    prompt_guidance: branches || [],
    recent_approved_lessons: lessons || [],
  };
}

async function scheduleFollowUpsIfDue() {
  const now = Date.now();
  if (now - lastFollowUpScanAt < FOLLOW_UP_SCAN_MS) return null;
  lastFollowUpScanAt = now;
  try {
    return await rpc("v8_create_follow_up_tasks", {
      p_limit: 200,
      p_dry_run: false,
      p_requested_by: "railway_follow_up_scheduler",
    });
  } catch (error) {
    lastFollowUpScanAt = 0;
    throw error;
  }
}

async function dispatchFollowUp(item) {
  const prepared = await rpc("v8_prepare_follow_up_ai_request", { p_request_id: item.id });
  if (!prepared?.ok || prepared?.skipped) return prepared;

  const [providers, governance] = await Promise.all([
    rest(`v8_ai_providers?provider_key=eq.${encodeURIComponent(prepared.provider_key || "openai")}&select=provider_key,provider_type,base_url,model_name,api_key_ciphertext,is_enabled&limit=1`),
    loadFollowUpGovernance(prepared.page_id),
  ]);
  const provider = providers?.[0];
  if (!provider?.is_enabled || !provider?.api_key_ciphertext) throw new Error("AI_PROVIDER_NOT_READY");
  const apiKey = decryptProviderKey(provider.api_key_ciphertext);
  const base = String(prepared.provider_base_url || provider.base_url || "https://api.openai.com/v1").replace(/\/$/, "");
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      should_reply: { type: "boolean" },
      final_reply: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      action_type: { type: "string" },
      should_request_contact: { type: "boolean" },
      reason: { type: "string" },
      risk_flags: { type: "array", items: { type: "string" }, maxItems: 8 },
    },
    required: ["should_reply", "final_reply", "confidence", "action_type", "should_request_contact", "reason", "risk_flags"],
  };
  const response = await fetch(`${base}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: prepared.model_name || provider.model_name,
      instructions: "Bạn là AIGUKA Follow-up Brain và là bên duy nhất quyết định có chăm sóc lại khách hay không. Đọc toàn bộ hội thoại, customer profile, AI memory, slide_context, priority_event và governance mới nhất. Context, rule, template và bài học chỉ là cố vấn; bạn quyết định nội dung cuối cùng. Chỉ nhắn khi khách chưa phản hồi, chưa có SĐT/Zalo và không có Sale/Admin chăm mới hơn. Tin ngắn, tự nhiên, không lặp tin cũ, không lặp ảnh đã gửi, không bịa giá, thông số hoặc cam kết. Nếu khách đã xin mẫu, chưa được gửi slide, slide_context có tài sản verified đúng sản phẩm và Admin/Sale mới chỉ xin liên hệ, bạn có thể quyết định gửi mẫu lần đầu bằng action_type=follow_up_with_requested_slides; không dùng action_type này khi ảnh sai, đã gửi hoặc không còn phù hợp. Dùng đúng preferred_salutation: self-reference/Admin xác minh ưu tiên, nhận diện tên độ tin cậy cao là bằng chứng phụ, tên mơ hồ dùng bạn/câu trung tính, tuyệt đối không dùng anh/chị. Khách có tín hiệu mua như hỏi giá, xin mẫu, combo, kích thước, vận chuyển, showroom, đang hoàn thiện nhà hoặc nói muốn mua thì ưu tiên xin SĐT/Zalo bằng lợi ích cụ thể. Với Page Tổng Kho có thể lồng tối đa hai quyền lợi ngắn, đúng ngữ cảnh và chưa lặp: quà tặng tùy đơn hàng/chương trình và hỗ trợ chi phí di chuyển khi khách đến showroom xem, đặt hàng/đặt cọc, tùy khoảng cách. Không nêu con số hoặc cam kết chưa được xác minh, không gửi cả khối chương trình. Nếu không phù hợp thì should_reply=false. Bắt buộc gọi submit_follow_up_decision.",
      tools: [{ type: "function", name: "submit_follow_up_decision", strict: true, description: "Nộp quyết định chăm sóc lại.", parameters: schema }],
      tool_choice: "required",
      parallel_tool_calls: false,
      input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify({
        task: "scheduled_follow_up_after_silence",
        trigger: prepared.details,
        slide_context: prepared.slide_context,
        slide_candidates: prepared.slide_candidates,
        customer: prepared.customer,
        conversation_state: prepared.conversation_state,
        ai_memory: prepared.memory,
        conversation: prepared.conversation,
        governance,
      }) }] }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const rawText = await response.text();
  let payload;
  try { payload = rawText ? JSON.parse(rawText) : {}; } catch { payload = { raw: rawText.slice(0, 500) }; }
  if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `OPENAI_FOLLOW_UP_HTTP_${response.status}`);
  const decision = parseFollowUpDecision(payload);
  return rpc("v8_complete_follow_up_ai_request", {
    p_request_id: item.id,
    p_decision: decision,
    p_model_name: prepared.model_name || provider.model_name,
    p_response_id: payload.id || null,
  });
}

async function dispatchBrain(item) {
  if (String(item.requested_by || "") === "follow_up_scan") {
    try {
      return await dispatchFollowUp(item);
    } catch (error) {
      await rpc("v8_fail_follow_up_ai_request", {
        p_request_id: item.id,
        p_error: String(error?.message || error).slice(0, 800),
      }).catch(() => {});
      throw error;
    }
  }
  const response = await fetch(`${SUPABASE_URL}/functions/v1/aiguka-v8-ai-brain`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ request_id: item.id }),
    signal: AbortSignal.timeout(90_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok && response.status !== 409) throw new Error(data?.error || `AI_BRAIN_HTTP_${response.status}`);
  if (response.ok && data?.ok === false) throw new Error(data?.error || "AI_BRAIN_REPORTED_FAILURE");
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
        profile_ready: profile.ready,
        display_name: profile.customer?.display_name || null,
        gender: profile.customer?.gender || null,
        preferred_salutation: profile.customer?.preferred_salutation || null,
        brain_result: result?.ok ?? true,
        requested_by: item.requested_by || null,
        follow_up_routed: String(item.requested_by || "") === "follow_up_scan",
      },
    }).catch(() => {});
    return true;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 800);
    console.error(`[AIGUKA AI dispatch] ${item.id}:`, message);
    await rpc("v8_finish_ai_dispatch", {
      p_request_id: item.id,
      p_worker: WORKER_NAME,
      p_success: false,
      p_error: message,
      p_details: { requested_by: item.requested_by || null },
    }).catch(() => {});
    return false;
  }
}

async function poll() {
  if (!configured() || running) return;
  running = true;
  let followUpScan = null;
  try {
    try {
      followUpScan = await scheduleFollowUpsIfDue();
    } catch (error) {
      console.error("[AIGUKA follow-up scheduler]", String(error?.message || error));
    }

    const claimed = await rpc("v8_claim_ai_dispatch_batch", {
      p_worker: WORKER_NAME,
      p_batch_size: 5,
    });
    let failures = 0;
    for (const item of Array.isArray(claimed) ? claimed : []) {
      const ok = await processItem(item);
      if (!ok) failures += 1;
    }
    const scanDetails = followUpScan ? {
      follow_up_last_scan_at: new Date().toISOString(),
      follow_up_candidates: Number(followUpScan.candidates || 0),
      follow_up_requests_created: Number(followUpScan.ai_requests_created || 0),
    } : {};
    if (failures > 0) {
      await heartbeat("degraded", `${failures}/${claimed.length} AI dispatch item(s) failed`, scanDetails);
    } else {
      await heartbeat("healthy", null, scanDetails);
    }
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
  console.log(`[AIGUKA AI dispatch] Worker ${WORKER_NAME} started; poll ${POLL_MS}ms; follow-up scan ${FOLLOW_UP_SCAN_MS}ms`);
}

await startAiDispatchWorker();
