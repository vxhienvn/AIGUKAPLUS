import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "outbound-worker.js";
const marker = "AIGUKA_HUMAN_TAKEOVER_PREFLIGHT_V1";
let source = fs.readFileSync(file, "utf8");

if (source.includes(marker)) {
  console.log("[AIGUKA] Human takeover preflight already installed");
} else {
  source = source.replace(
    'const WORKER_VERSION = "production_v1";',
    'const WORKER_VERSION = "production_v2_human_takeover"; // AIGUKA_HUMAN_TAKEOVER_PREFLIGHT_V1',
  );

  source = source.replace(
    "        page_verification: true,",
    "        page_verification: true,\n        conversation_history_preflight: true,\n        message_echoes: true,",
  );

  const oldFields = 'const requiredFields = ["messages", "messaging_postbacks", "message_deliveries", "message_reads", "messaging_referrals"];';
  const newFields = 'const requiredFields = ["messages", "message_echoes", "messaging_postbacks", "message_deliveries", "message_reads", "messaging_referrals"];';
  if (!source.includes(oldFields)) throw new Error("OUTBOUND_SUBSCRIBED_FIELDS_ANCHOR_NOT_FOUND");
  source = source.replace(oldFields, newFields);

  const buildAnchor = "function buildMetaMessage(item) {";
  if (!source.includes(buildAnchor)) throw new Error("OUTBOUND_BUILD_MESSAGE_ANCHOR_NOT_FOUND");
  const preflightCode = `async function syncConversationHistoryBeforeSend(item) {
  const token = await pageToken(item.page_id);
  if (!token) return { ok: false, synced: false, reason: "PAGE_ACCESS_TOKEN_NOT_FOUND" };

  try {
    const conversations = await graph(\`${"${item.page_id}"}/conversations\`, token, {
      query: {
        user_id: String(item.sender_id),
        fields: "id,updated_time",
        limit: 1,
      },
      timeout: 12_000,
    });
    const conversation = (conversations?.data || [])[0];
    if (!conversation?.id) return { ok: true, synced: false, reason: "CONVERSATION_NOT_FOUND" };

    const detail = await graph(String(conversation.id), token, {
      query: {
        fields: "messages.limit(25){id,created_time,from,to,message,attachments}",
      },
      timeout: 12_000,
    });
    const messages = detail?.messages?.data || [];
    if (!messages.length) return { ok: true, synced: false, reason: "NO_HISTORY_MESSAGES" };

    const result = await rpc("v8_sync_conversation_history_preflight", {
      p_page_id: String(item.page_id),
      p_sender_id: String(item.sender_id),
      p_conversation_id: String(conversation.id),
      p_messages: messages,
    });
    return { ok: true, synced: true, conversation_id: conversation.id, ...result };
  } catch (error) {
    console.warn(\`[AIGUKA outbound preflight] ${"${item.id}"}: ${"${error.message}"}\`);
    return { ok: false, synced: false, reason: String(error.message).slice(0, 300) };
  }
}

`;
  source = source.replace(buildAnchor, preflightCode + buildAnchor);

  const oldProcess = `async function processItem(item) {
  try {
    const authorization = await rpc("v8_authorize_outbound_send", { p_outbound_id: item.id, p_worker_name: WORKER_NAME });
    if (!authorization?.allowed) return;
    const confirmation = await rpc("v8_confirm_outbound_transport", { p_outbound_id: item.id, p_worker_name: WORKER_NAME });
    if (!confirmation?.allowed) return;
    const result = await sendMeta({ ...item, payload: confirmation.payload || item.payload, message_type: confirmation.message_type || item.message_type });
    await rpc("v8_complete_outbound", { p_outbound_id: item.id, p_worker_name: WORKER_NAME, p_external_message_id: result.message_id || null });
  } catch (error) {
    console.error(\`[AIGUKA outbound] ${"${item.id}"}:\`, error.message);
    await rpc("v8_fail_outbound", { p_outbound_id: item.id, p_worker_name: WORKER_NAME, p_error: String(error.message).slice(0, 500), p_retry_seconds: 30 }).catch(() => {});
  }
}`;

  const newProcess = `async function processItem(item) {
  try {
    // Đồng bộ vài tin gần nhất ngay trước Final Gate. Nếu Sale/Admin vừa nhắn
    // nhưng webhook echo đến chậm hoặc bị thiếu, bản ghi lịch sử sẽ kích hoạt
    // manual_pause và hủy outbound đang ở trạng thái sending.
    const preflight = await syncConversationHistoryBeforeSend(item);
    if (!preflight?.ok) {
      // Không làm worker chết khi Conversations API lỗi tạm thời. Final Gate,
      // message_echoes và các trigger DB vẫn là các lớp bảo vệ còn lại.
      console.warn(\`[AIGUKA outbound] History preflight unavailable for ${"${item.id}"}: ${"${preflight?.reason || \"unknown\"}"}\`);
    }

    const authorization = await rpc("v8_authorize_outbound_send", { p_outbound_id: item.id, p_worker_name: WORKER_NAME });
    if (!authorization?.allowed) return;
    const confirmation = await rpc("v8_confirm_outbound_transport", { p_outbound_id: item.id, p_worker_name: WORKER_NAME });
    if (!confirmation?.allowed) return;
    const result = await sendMeta({ ...item, payload: confirmation.payload || item.payload, message_type: confirmation.message_type || item.message_type });
    await rpc("v8_complete_outbound", { p_outbound_id: item.id, p_worker_name: WORKER_NAME, p_external_message_id: result.message_id || null });
  } catch (error) {
    console.error(\`[AIGUKA outbound] ${"${item.id}"}:\`, error.message);
    await rpc("v8_fail_outbound", { p_outbound_id: item.id, p_worker_name: WORKER_NAME, p_error: String(error.message).slice(0, 500), p_retry_seconds: 30 }).catch(() => {});
  }
}`;

  if (!source.includes(oldProcess)) throw new Error("OUTBOUND_PROCESS_ITEM_ANCHOR_NOT_FOUND");
  source = source.replace(oldProcess, newProcess);

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`OUTBOUND_HUMAN_TAKEOVER_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Human takeover preflight installed before outbound Final Gate");
}
