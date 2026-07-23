// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = String(Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const SERVICE_KEY = String(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
const ADMIN_SECRET = String(Deno.env.get("AIGUKA_V8_ADMIN_SECRET") || Deno.env.get("META_VERIFY_TOKEN") || "");
const VERSION = 6;
const PROMPT_VERSION = "evidence_first_single_call_v2";
const H = {
  "Access-Control-Allow-Origin": SUPABASE_URL || "null",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-aiguka-brain-secret,x-aiguka-admin-secret",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Cache-Control": "no-store",
};
const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...H, "content-type": "application/json; charset=utf-8" } });
const text = (v: unknown) => String(v ?? "").trim();
const trimText = (v: unknown, n = 900) => text(v).slice(0, n);
const clamp = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(v) || 0));
const normalize = (v: unknown) => text(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const safeJson = (v: unknown) => { try { return typeof v === "string" ? JSON.parse(v) : (v || {}); } catch { return {}; } };
const db = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function authorized(req: Request) {
  const bearer = text(req.headers.get("authorization")).replace(/^Bearer\s+/i, "");
  const secret = text(req.headers.get("x-aiguka-brain-secret") || req.headers.get("x-aiguka-admin-secret"));
  return Boolean((SERVICE_KEY && bearer === SERVICE_KEY) || (ADMIN_SECRET && secret === ADMIN_SECRET));
}
function safeError(error: any) {
  return trimText(error?.error?.message || error?.message || error?.error_description || error?.error || "ai_brain_error", 800)
    .replace(/[A-Za-z0-9_\-]{28,}/g, "[redacted]");
}
function deepFind(obj: any, keys: string[]) {
  const seen = new Set();
  const walk = (value: any, depth: number): string | null => {
    if (!value || depth > 6 || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (keys.includes(key.toLowerCase()) && ["string", "number"].includes(typeof child)) {
        const found = text(child); if (found) return found;
      }
    }
    for (const child of Object.values(value)) { const found = walk(child, depth + 1); if (found) return found; }
    return null;
  };
  return walk(obj, 0);
}
function queryTokens(v: unknown) {
  return [...new Set(normalize(v).split(" ").filter((x) => x.length >= 3))].slice(0, 24);
}
function scoreObject(value: unknown, tokens: string[]) {
  const hay = normalize(JSON.stringify(value));
  return tokens.reduce((sum, token) => sum + (hay.includes(token) ? 1 : 0), 0);
}
function extractImageUrls(attachments: any): string[] {
  const found: string[] = [];
  const walk = (value: any, depth = 0) => {
    if (!value || depth > 6) return;
    if (Array.isArray(value)) { for (const x of value) walk(x, depth + 1); return; }
    if (typeof value !== "object") return;
    const kind = normalize(value.type || value.mime_type || value.name || "");
    const candidate = text(value.url || value.preview_url || value.image_data?.url || value.payload?.url);
    if (candidate && /^https:\/\//i.test(candidate) && (!kind || /image|photo|jpg|jpeg|png|webp/.test(kind))) found.push(candidate);
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(attachments);
  return [...new Set(found)].slice(0, 2);
}
function isOptOut(message: string) {
  return /^(unsubscribe|stop|dung nhan|dung gui|khong nhan nua|khong gui nua|huy dang ky)\b/i.test(normalize(message));
}
function isNoValueTurn(message: string, hasImages: boolean) {
  if (hasImages) return false;
  const n = normalize(message);
  return !n || /^(ok|oke|okay|cam on|thanks|thank you|vang|da|uh|um|👍|❤️|❤)$/.test(n);
}
function asksForSlides(message: string) {
  return /(^| )(xin mau|xem mau|gui mau|mau nao|catalog|hinh anh|anh that|gui anh|xem anh|cho xem)( |$)/.test(normalize(message));
}
function asksForPrice(message: string) {
  return /(^| )(gia|bao gia|bao nhieu|xin gia)( |$)/.test(normalize(message));
}
function hasNumericPrice(v: string) {
  return /\b\d+[\d.,]*\s*(trieu|nghin|k|d|vnd)\b/i.test(normalize(v));
}
function parseDecision(payload: any) {
  for (const item of payload?.output || []) {
    if (item?.type === "function_call" && item?.name === "submit_decision") return safeJson(item.arguments);
  }
  throw new Error("MODEL_DID_NOT_SUBMIT_DECISION");
}
async function openaiCall(provider: any, apiKey: string, payload: any) {
  const base = text(provider.base_url || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${base}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) throw new Error(`OpenAI HTTP ${response.status}: ${safeError(data)}`);
  return data;
}

const decisionSchema = {
  type: "object", additionalProperties: false,
  properties: {
    customer_goal: { type: "string" },
    intent_type: { type: "string", enum: ["greeting", "ask_price", "ask_product_info", "ask_sample", "ask_address", "ask_shipping", "purchase_intent", "provide_contact", "complaint", "opt_out", "acknowledgement", "other"] },
    product_scope: { type: ["string", "null"] },
    catalog_keys: { type: "array", items: { type: "string" }, maxItems: 5 },
    conversation_stage: { type: "string", enum: ["new", "exploring", "evaluating", "ready_to_buy", "handoff", "closed"] },
    action_type: { type: "string", enum: ["reply_text", "reply_with_slides", "ask_clarification", "handoff_sale", "no_reply"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    should_reply: { type: "boolean" },
    final_reply: { type: "string" },
    needs_clarification: { type: "boolean" },
    clarification_question: { type: ["string", "null"] },
    should_send_slide: { type: "boolean" },
    should_request_contact: { type: "boolean" },
    should_handoff_sale: { type: "boolean" },
    evidence_summary: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, properties: {
      source_type: { type: "string" }, source_id: { type: ["string", "null"] }, claim: { type: "string" }
    }, required: ["source_type", "source_id", "claim"] } },
    risk_flags: { type: "array", items: { type: "string" }, maxItems: 6 },
    reason: { type: "string" },
    memory_update: { type: "object", additionalProperties: false, properties: {
      active_goal: { type: ["string", "null"] }, summary: { type: "string" }, product_scope: { type: ["string", "null"] },
      contact_status: { type: "string" }, pending_actions: { type: "array", items: { type: "string" }, maxItems: 3 }
    }, required: ["active_goal", "summary", "product_scope", "contact_status", "pending_actions"] }
  },
  required: ["customer_goal", "intent_type", "product_scope", "catalog_keys", "conversation_stage", "action_type", "confidence", "should_reply", "final_reply", "needs_clarification", "clarification_question", "should_send_slide", "should_request_contact", "should_handoff_sale", "evidence_summary", "risk_flags", "reason", "memory_update"]
};
const submitTool = { type: "function", name: "submit_decision", strict: true, description: "Nộp đúng một quyết định cuối cùng cho lượt khách.", parameters: decisionSchema };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method === "GET") return out({ ok: true, service: "aiguka-v8-ai-brain", version: VERSION, architecture: PROMPT_VERSION, history: "4_customer_messages", model_calls_per_turn: 1 });
  if (req.method !== "POST") return out({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  if (!authorized(req)) return out({ ok: false, error: "UNAUTHORIZED" }, 401);

  const c = db();
  let body: any; try { body = await req.json(); } catch { return out({ ok: false, error: "INVALID_JSON" }, 400); }
  const requestId = text(body.request_id);
  if (!requestId) return out({ ok: false, error: "MISSING_REQUEST_ID" }, 400);

  const { data: requestRow } = await c.from("v8_ai_brain_requests").select("*").eq("id", requestId).maybeSingle();
  if (!requestRow || !["pending", "error", "processing"].includes(requestRow.status)) return out({ ok: false, error: "INVALID_OR_COMPLETED_REQUEST" }, 409);
  const pageId = text(requestRow.page_id), senderId = text(requestRow.sender_id), messageId = text(requestRow.message_id);
  if (!pageId || !senderId || !messageId) return out({ ok: false, error: "MISSING_IDENTIFIERS" }, 400);

  await c.from("v8_ai_brain_requests").update({ status: "processing", started_at: new Date().toISOString(), attempts: Number(requestRow.attempts || 0) + 1, last_error: null }).eq("id", requestId);
  let decisionId: string | null = null;

  try {
    const { data: runtime } = await c.from("v8_ai_brain_runtime").select("*").eq("page_id", pageId).maybeSingle();
    if (!runtime || runtime.mode === "OFF") {
      await c.from("v8_ai_brain_requests").update({ status: "skipped", completed_at: new Date().toISOString(), last_error: "brain_off" }).eq("id", requestId);
      return out({ ok: true, skipped: true, reason: "brain_off" });
    }
    const { data: provider } = await c.from("v8_ai_providers").select("*").eq("provider_key", runtime.provider_key || "openai").maybeSingle();
    if (!provider?.is_enabled) throw new Error("AI_PROVIDER_DISABLED");
    const apiKey = text(Deno.env.get(text(provider.api_key_secret_name || "OPENAI_API_KEY")));
    if (!apiKey) throw new Error("MISSING_AI_SECRET");

    let current: any = null;
    for (let i = 0; i < 5 && !current; i++) {
      const { data } = await c.from("v8_messages_raw").select("*").eq("page_id", pageId).eq("message_id", messageId).maybeSingle();
      current = data; if (!current) await sleep(120);
    }
    if (!current) throw new Error("SOURCE_MESSAGE_NOT_FOUND");
    if (current.direction !== "inbound" || current.actor_type !== "customer") throw new Error("INBOUND_CUSTOMER_MESSAGE_REQUIRED");

    const { data: newerInbound } = await c.from("v8_messages_raw").select("message_id,sent_at").eq("page_id", pageId).eq("sender_id", senderId)
      .eq("direction", "inbound").eq("actor_type", "customer").gt("sent_at", current.sent_at).order("sent_at", { ascending: false }).limit(1);
    if ((newerInbound || []).length) {
      await c.from("v8_ai_brain_requests").update({ status: "skipped", completed_at: new Date().toISOString(), last_error: "superseded_before_model_call", dispatch_details: { ...(requestRow.dispatch_details || {}), superseded_by_message_id: newerInbound[0].message_id, quota_saved: true } }).eq("id", requestId);
      return out({ ok: true, skipped: true, reason: "superseded_before_model_call", quota_saved: true });
    }

    let customerId = current.customer_id;
    if (!customerId) {
      const { data } = await c.from("v8_customers").select("id").eq("page_id", pageId).eq("sender_id", senderId).maybeSingle();
      customerId = data?.id || null;
    }
    const { data: customer } = customerId ? await c.from("v8_customers").select("id,display_name,phone,zalo,preferred_salutation,profile_sync_status,lead_state,assigned_sale,last_product_key,last_intent_type").eq("id", customerId).maybeSingle() : { data: null };
    const { data: state } = customerId ? await c.from("v8_conversation_states").select("stage,has_phone,sale_handoff_ready,manual_pause_until,last_human_message_at,last_outbound_actor,last_outbound_source").eq("customer_id", customerId).maybeSingle() : { data: null };
    if (state?.manual_pause_until && new Date(state.manual_pause_until).getTime() > Date.now()) {
      await c.from("v8_ai_brain_requests").update({ status: "skipped", completed_at: new Date().toISOString(), last_error: "human_takeover_before_model_call", dispatch_details: { ...(requestRow.dispatch_details || {}), quota_saved: true } }).eq("id", requestId);
      return out({ ok: true, skipped: true, reason: "human_takeover_before_model_call", quota_saved: true });
    }
    if (state?.last_human_message_at && new Date(state.last_human_message_at).getTime() > new Date(current.sent_at).getTime()) {
      await c.from("v8_ai_brain_requests").update({ status: "skipped", completed_at: new Date().toISOString(), last_error: "human_replied_before_model_call", dispatch_details: { ...(requestRow.dispatch_details || {}), quota_saved: true } }).eq("id", requestId);
      return out({ ok: true, skipped: true, reason: "human_replied_before_model_call", quota_saved: true });
    }

    const { data: customerHistoryDesc } = await c.from("v8_messages_raw")
      .select("message_id,message_text,attachments,sent_at")
      .eq("page_id", pageId).eq("sender_id", senderId)
      .eq("direction", "inbound").eq("actor_type", "customer")
      .lte("sent_at", current.sent_at).order("sent_at", { ascending: false }).limit(4);
    const customerHistory = (customerHistoryDesc || []).reverse().map((m: any) => ({
      message_id: m.message_id, text: trimText(m.message_text, 420), has_image: extractImageUrls(m.attachments).length > 0, sent_at: m.sent_at,
    }));
    const imageUrls = [...new Set((customerHistoryDesc || []).flatMap((m: any) => extractImageUrls(m.attachments)))].slice(0, 2);
    const turnText = customerHistory.filter((m: any) => new Date(m.sent_at).getTime() >= new Date(current.sent_at).getTime() - 45000)
      .map((m: any) => text(m.text)).filter(Boolean).join("\n") || text(current.message_text);

    if (isOptOut(turnText)) {
      await c.from("v8_ai_brain_requests").update({ status: "skipped", completed_at: new Date().toISOString(), last_error: "customer_opt_out_no_model", dispatch_details: { ...(requestRow.dispatch_details || {}), quota_saved: true } }).eq("id", requestId);
      return out({ ok: true, skipped: true, reason: "customer_opt_out_no_model", quota_saved: true });
    }
    if (isNoValueTurn(turnText, imageUrls.length > 0)) {
      await c.from("v8_ai_brain_requests").update({ status: "skipped", completed_at: new Date().toISOString(), last_error: "acknowledgement_no_model", dispatch_details: { ...(requestRow.dispatch_details || {}), quota_saved: true } }).eq("id", requestId);
      return out({ ok: true, skipped: true, reason: "acknowledgement_no_model", quota_saved: true });
    }

    const { data: memory } = customerId ? await c.from("v8_conversation_memory_ai").select("active_goal,summary,memory,updated_at").eq("customer_id", customerId).maybeSingle() : { data: null };
    const adId = deepFind({ raw_payload: current.raw_payload, source_detail: current.source_detail }, ["ad_id", "adid"]);
    const adTitle = deepFind({ raw_payload: current.raw_payload, source_detail: current.source_detail }, ["ad_title", "ad_name"]);
    let adMapping: any = null;
    if (adId) {
      const { data } = await c.from("ad_mappings").select("ad_id,ad_name,campaign_name,adset_name,product_type,product_name,product_group,product_item_key,recognition_name,slide_key,price_range,notes,is_active,enabled").eq("ad_id", adId).maybeSingle();
      adMapping = data;
    }

    const tokens = queryTokens(`${turnText} ${adTitle || ""} ${adMapping?.product_name || ""} ${adMapping?.product_group || ""}`);
    const [contextsRes, branchesRes, lessonsRes, catalogRes, aliasesRes] = await Promise.all([
      c.from("v8_ai_contexts").select("id,context_key,content,priority").eq("is_active", true).eq("usage_mode", "PRODUCTION").or(`page_id.is.null,page_id.eq.${pageId}`).order("priority").limit(20),
      c.from("v8_prompt_branches").select("id,branch_key,instruction_text,example_good_reply,priority").eq("is_active", true).order("priority").limit(25),
      c.from("v8_behavior_learning_cases").select("id,customer_message,improved_reply,context_summary,business_group_key,intent_type").in("status", ["approved", "applied"]).order("updated_at", { ascending: false }).limit(20),
      c.from("v8_product_catalog").select("catalog_key,catalog_name,parent_key,root_product_key,level_no,is_sendable").eq("is_active", true).limit(300),
      c.from("v8_product_aliases").select("catalog_key,alias,normalized_alias,confidence,priority").eq("is_active", true).order("priority").limit(500),
    ]);

    const relevantRule = (contextsRes.data || []).map((x: any) => ({ ...x, score: scoreObject(x, tokens) })).sort((a: any, b: any) => b.score - a.score || a.priority - b.priority).slice(0, 1)
      .map((x: any) => ({ key: x.context_key, text: trimText(x.content, 650) }));
    const relevantGuidance = (branchesRes.data || []).map((x: any) => ({ ...x, score: scoreObject(x, tokens) })).filter((x: any) => x.score > 0).sort((a: any, b: any) => b.score - a.score || a.priority - b.priority).slice(0, 1)
      .map((x: any) => ({ key: x.branch_key, instruction: trimText(x.instruction_text, 450), example: trimText(x.example_good_reply, 260) }));
    const similarLesson = (lessonsRes.data || []).map((x: any) => ({ ...x, score: scoreObject(x, tokens) })).filter((x: any) => x.score > 0).sort((a: any, b: any) => b.score - a.score).slice(0, 1)
      .map((x: any) => ({ id: x.id, customer: trimText(x.customer_message, 220), better_reply: trimText(x.improved_reply, 320) }));

    const aliasMap = new Map<string, any[]>();
    for (const a of aliasesRes.data || []) { const arr = aliasMap.get(a.catalog_key) || []; arr.push(a); aliasMap.set(a.catalog_key, arr); }
    const mappingKeys = new Set([adMapping?.slide_key, adMapping?.product_item_key, adMapping?.product_group, adMapping?.product_type, customer?.last_product_key].map(normalize).filter(Boolean));
    const catalogCandidates = (catalogRes.data || []).map((item: any) => {
      const aliases = (aliasMap.get(item.catalog_key) || []).map((a: any) => `${a.alias} ${a.normalized_alias}`).join(" ");
      const hay = normalize(`${item.catalog_key} ${item.catalog_name} ${item.root_product_key} ${aliases}`);
      let score = mappingKeys.has(normalize(item.catalog_key)) || mappingKeys.has(normalize(item.root_product_key)) ? 30 : 0;
      for (const token of tokens) if (hay.includes(token)) score += 1;
      return { ...item, score };
    }).filter((x: any) => x.score > 0).sort((a: any, b: any) => b.score - a.score || a.level_no - b.level_no).slice(0, 8)
      .map((x: any) => ({ catalog_key: x.catalog_key, catalog_name: x.catalog_name, root_product_key: x.root_product_key, sendable: x.is_sendable }));

    const priceCandidates: any[] = [];
    if (asksForPrice(turnText)) {
      const exactKeys = new Set([adMapping?.product_item_key, adMapping?.product_group, adMapping?.product_name, catalogCandidates[0]?.root_product_key, catalogCandidates[0]?.catalog_key].map(normalize).filter(Boolean));
      if (exactKeys.size) {
        const { data: mappings } = await c.from("ad_mappings").select("ad_id,product_name,product_group,product_item_key,price_range").not("price_range", "is", null).limit(250);
        for (const item of mappings || []) {
          const fields = [item.product_item_key, item.product_group, item.product_name].map(normalize).filter(Boolean);
          if (fields.some((f: string) => exactKeys.has(f)) && text(item.price_range)) {
            priceCandidates.push({ source_id: item.ad_id, product: item.product_name || item.product_group || item.product_item_key, price_range: text(item.price_range) });
            if (priceCandidates.length >= 2) break;
          }
        }
      }
    }

    const fixedSalutation = text(customer?.preferred_salutation) || null;
    const evidence = {
      latest_turn: { text: trimText(turnText, 1200), has_images: imageUrls.length > 0, asks_for_samples: asksForSlides(turnText), asks_for_price: asksForPrice(turnText) },
      customer_messages: customerHistory,
      customer: { name: customer?.display_name || null, fixed_salutation: fixedSalutation, salutation_must_not_be_inferred: true, has_contact: Boolean(customer?.phone || customer?.zalo || state?.has_phone), assigned_sale: customer?.assigned_sale || null },
      state: state ? { stage: state.stage, sale_handoff_ready: state.sale_handoff_ready } : null,
      memory: memory ? { active_goal: memory.active_goal, summary: trimText(memory.summary || memory.memory?.summary, 420) } : null,
      referral: { ad_id: adId, ad_title: trimText(adTitle, 220), mapped_product: adMapping ? { product_type: adMapping.product_type, product_group: adMapping.product_group, product_name: adMapping.product_name, product_item_key: adMapping.product_item_key, slide_key: adMapping.slide_key, notes: trimText(adMapping.notes, 240) } : null },
      catalog_candidates: catalogCandidates,
      verified_price_candidates: priceCandidates,
      relevant_rule: relevantRule,
      relevant_guidance: relevantGuidance,
      similar_lesson: similarLesson,
      constraints: { numeric_price_allowed: priceCandidates.length > 0, catalog_keys_must_come_from_candidates: true, image_assets_are_selected_by_system: true, promotion_not_requested: true }
    };
    const contextBytes = new TextEncoder().encode(JSON.stringify(evidence)).length;

    const { data: snapshot, error: snapshotError } = await c.from("v8_ai_context_snapshots").upsert({
      page_id: pageId, sender_id: senderId, customer_id: customerId, message_id: messageId, source_message_row_id: current.id,
      runtime_mode: runtime.mode, conversation: customerHistory, customer_state: { customer, state, memory }, ad_context: { ad_id: adId, ad_title: adTitle, mapping: adMapping }, initial_context: evidence
    }, { onConflict: "page_id,message_id" }).select("id").single();
    if (snapshotError) throw snapshotError;

    const { data: prior } = await c.from("v8_ai_decisions").select("*").eq("page_id", pageId).eq("message_id", messageId).maybeSingle();
    if (prior?.status === "completed") {
      await c.from("v8_ai_brain_requests").update({ status: "completed", decision_id: prior.id, completed_at: new Date().toISOString() }).eq("id", requestId);
      return out({ ok: true, deduped: true, decision_id: prior.id, decision: prior.decision });
    }

    const modelName = text(runtime.model_name || provider.model_name || "gpt-5.4-mini");
    const { data: decisionRow, error: decisionError } = await c.from("v8_ai_decisions").upsert({
      snapshot_id: snapshot.id, page_id: pageId, sender_id: senderId, customer_id: customerId, message_id: messageId, source_message_row_id: current.id,
      runtime_mode: runtime.mode, provider_key: provider.provider_key, model_name: modelName, status: "processing", error: null,
      started_at: new Date().toISOString(), updated_at: new Date().toISOString(), prompt_version: PROMPT_VERSION, model_calls: 1, context_bytes: contextBytes
    }, { onConflict: "page_id,message_id" }).select("id").single();
    if (decisionError) throw decisionError;
    decisionId = decisionRow.id;

    const instructions = `Bạn là AI bán hàng chính của AIGUKAPLUS. Chỉ xử lý nhu cầu mới nhất từ tối đa 4 tin gần nhất của khách.\nQUY TẮC BẮT BUỘC:\n1) Trả lời đúng câu khách vừa hỏi, tự nhiên, ngắn 1-3 câu; không lặp câu Page/automation, không gửi cả khối quảng cáo.\n2) Xưng hô chỉ dùng đúng customer.fixed_salutation khi có. Không có thì viết trung tính, tuyệt đối không tự đoán giới tính và không dùng cụm “anh/chị”.\n3) Nếu khách xin ảnh/xem mẫu/catalog: đặt should_send_slide=true và chọn catalog_keys từ catalog_candidates. Khách hỏi bao nhiêu nhóm sản phẩm thì chọn bấy nhiêu catalog; không chọn từng ảnh, hệ thống tự lấy ảnh từ mapping.\n4) Chỉ dùng giá có trong verified_price_candidates. Không có giá xác minh thì nói có nhiều mức tùy mẫu/cấu hình và xin SĐT/Zalo một lần khi phù hợp. Nếu đã có contact thì không xin lại.\n5) Không bịa tồn kho, thông số, bảo hành, vận chuyển, quà tặng hay chương trình. Không tự gửi ưu đãi khi khách không hỏi.\n6) Khi sản phẩm mơ hồ, hỏi đúng một câu làm rõ. Khi cần người thật, handoff_sale.\n7) Intent chỉ dùng enum đã cho. Bắt buộc gọi submit_decision đúng một lần, không xuất văn bản ngoài công cụ.`;
    const content: any[] = [{ type: "input_text", text: JSON.stringify(evidence) }];
    for (const url of imageUrls) content.push({ type: "input_image", image_url: url, detail: "low" });
    const response = await openaiCall(provider, apiKey, {
      model: modelName,
      instructions,
      tools: [submitTool],
      tool_choice: "required",
      parallel_tool_calls: false,
      input: [{ role: "user", content }],
      max_output_tokens: 1200,
    });

    const finalDecision = parseDecision(response);
    finalDecision.confidence = clamp(finalDecision.confidence, 0, 1);
    finalDecision.final_reply = trimText(finalDecision.final_reply, 1200);
    const allowedCatalogs = new Set(catalogCandidates.map((x: any) => text(x.catalog_key)));
    let selectedCatalogs = [...new Set((finalDecision.catalog_keys || []).map(text).filter((key: string) => allowedCatalogs.has(key)))].slice(0, 5);
    if (finalDecision.should_send_slide && selectedCatalogs.length === 0 && catalogCandidates.length) selectedCatalogs = [catalogCandidates[0].catalog_key];

    const slideAssetIds: string[] = [];
    if (finalDecision.should_send_slide && selectedCatalogs.length) {
      const perCatalogBase = Math.floor(10 / selectedCatalogs.length);
      const remainder = 10 % selectedCatalogs.length;
      for (let i = 0; i < selectedCatalogs.length; i++) {
        const key = selectedCatalogs[i];
        const wanted = Math.max(1, perCatalogBase + (i < remainder ? 1 : 0));
        const { data: descendants } = await c.rpc("v8_catalog_descendant_keys", { p_catalog_key: key });
        const keys = [...new Set([key, ...(descendants || []).map((x: any) => text(x.catalog_key)).filter(Boolean)])].slice(0, 100);
        const { data: assets } = await c.from("v8_drive_assets").select("id,catalog_key,sort_order,file_name")
          .eq("is_active", true).eq("is_image", true).eq("delivery_status", "verified").in("catalog_key", keys)
          .order("sort_order").order("file_name").limit(wanted);
        for (const asset of assets || []) slideAssetIds.push(String(asset.id));
      }
    }

    const risks = new Set((finalDecision.risk_flags || []).map(text).filter(Boolean));
    if (finalDecision.should_send_slide && slideAssetIds.length === 0) {
      finalDecision.should_send_slide = false;
      selectedCatalogs = [];
      risks.add("no_verified_slide_assets");
      if (/da gui|gui.*mau|gui.*anh|gui.*hinh/i.test(normalize(finalDecision.final_reply))) {
        finalDecision.final_reply = "Mình cho biết rõ mẫu hoặc nhóm sản phẩm cần xem, bên em gửi đúng catalog ngay ạ.";
        finalDecision.needs_clarification = true;
      }
    }
    if (hasNumericPrice(finalDecision.final_reply) && priceCandidates.length === 0) {
      risks.add("unverified_numeric_price_removed");
      finalDecision.final_reply = customer?.phone || customer?.zalo || state?.has_phone
        ? "Sản phẩm này có nhiều mức giá tùy mẫu và cấu hình. Bên em sẽ kiểm tra đúng mẫu rồi báo giá cụ thể ạ."
        : "Sản phẩm này có nhiều mức giá tùy mẫu và cấu hình. Mình để lại SĐT hoặc Zalo, bên em kiểm tra đúng mẫu và báo giá cụ thể ạ.";
      finalDecision.should_request_contact = !(customer?.phone || customer?.zalo || state?.has_phone);
    }
    finalDecision.risk_flags = [...risks];
    finalDecision.catalog_keys = selectedCatalogs;

    const catalogKey = selectedCatalogs.length > 1 ? "multi_product" : (selectedCatalogs[0] || null);
    const productScope = selectedCatalogs.length > 1 ? "multi_product" : (text(finalDecision.product_scope) || catalogKey);
    const usage = response?.usage || {};
    const inputTokens = Number(usage.input_tokens || 0);
    const outputTokens = Number(usage.output_tokens || 0);
    const totalTokens = Number(usage.total_tokens || inputTokens + outputTokens || 0);
    const cachedTokens = Number(usage.input_tokens_details?.cached_tokens || 0);
    const reasoningTokens = Number(usage.output_tokens_details?.reasoning_tokens || 0);
    const completedAt = new Date().toISOString();

    const decisionPayload = {
      status: "completed", customer_goal: trimText(finalDecision.customer_goal, 500), intent_type: text(finalDecision.intent_type), product_scope: productScope,
      catalog_key: catalogKey, confidence: finalDecision.confidence, should_reply: Boolean(finalDecision.should_reply), final_reply: finalDecision.final_reply,
      should_send_slide: Boolean(finalDecision.should_send_slide && slideAssetIds.length), slide_asset_ids: slideAssetIds,
      should_request_contact: Boolean(finalDecision.should_request_contact), should_handoff_sale: Boolean(finalDecision.should_handoff_sale),
      needs_clarification: Boolean(finalDecision.needs_clarification), decision: { ...finalDecision, catalog_keys: selectedCatalogs, slide_selection_mode: "system_from_catalog_mapping" },
      evidence_summary: finalDecision.evidence_summary || [], risk_flags: finalDecision.risk_flags || [], completed_at: completedAt, updated_at: completedAt,
      error: null, decision_authority: "ai_runtime", prompt_version: PROMPT_VERSION, model_calls: 1, context_bytes: contextBytes,
      input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens, cached_input_tokens: cachedTokens, reasoning_tokens: reasoningTokens, usage_details: usage,
    };
    const { error: updateError } = await c.from("v8_ai_decisions").update(decisionPayload).eq("id", decisionId);
    if (updateError) throw updateError;

    if (customerId && finalDecision.memory_update) {
      const m = finalDecision.memory_update;
      await c.from("v8_conversation_memory_ai").upsert({
        customer_id: customerId, page_id: pageId, sender_id: senderId,
        active_goal: text(m.active_goal) || null, summary: trimText(m.summary, 650),
        memory: { ...m, selected_catalog_keys: selectedCatalogs }, source_decision_id: decisionId, updated_at: completedAt
      }, { onConflict: "customer_id" });
    }

    const { data: stored } = await c.from("v8_ai_decisions").select("status").eq("id", decisionId).single();
    let staged: any = null;
    if (stored?.status === "completed") { const result = await c.rpc("v8_ai_stage_decision", { p_decision_id: decisionId }); staged = result.data; }
    await c.from("v8_ai_brain_requests").update({
      status: "completed", decision_id: decisionId, completed_at: completedAt, last_error: null,
      dispatch_details: { ...(requestRow.dispatch_details || {}), prompt_version: PROMPT_VERSION, model_calls: 1, history_customer_messages: customerHistory.length, selected_catalog_keys: selectedCatalogs, slide_assets_selected_by_system: slideAssetIds.length, context_bytes: contextBytes, input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens }
    }).eq("id", requestId);

    return out({ ok: true, decision_id: decisionId, decision_status: stored?.status, staged, prompt_version: PROMPT_VERSION, model_calls: 1, usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens, cached_tokens: cachedTokens }, selected_catalog_keys: selectedCatalogs, slide_assets_selected_by_system: slideAssetIds.length, decision: finalDecision });
  } catch (error) {
    const message = safeError(error), now = new Date().toISOString();
    if (decisionId) await c.from("v8_ai_decisions").update({ status: "error", error: message, completed_at: now, updated_at: now }).eq("id", decisionId);
    await c.from("v8_ai_brain_requests").update({ status: "error", completed_at: now, last_error: message, decision_id: decisionId }).eq("id", requestId);
    return out({ ok: false, error: message, decision_id: decisionId }, 500);
  }
});