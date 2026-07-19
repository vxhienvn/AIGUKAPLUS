import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "outbound-worker.js";
const marker = "AIGUKA_COMMENT_PRIVATE_REPLY_V1";
let source = fs.readFileSync(file, "utf8");

if (source.includes(marker)) {
  console.log("[AIGUKA] Comment private reply transport already installed");
} else {
  source = source.replace(
    'const WORKER_VERSION = "production_v2_human_takeover"; // AIGUKA_HUMAN_TAKEOVER_PREFLIGHT_V1',
    'const WORKER_VERSION = "production_v3_comment_private_reply"; // AIGUKA_HUMAN_TAKEOVER_PREFLIGHT_V1 AIGUKA_COMMENT_PRIVATE_REPLY_V1',
  );

  source = source.replace(
    "        message_echoes: true,",
    "        message_echoes: true,\n        comment_private_reply: true,\n        feed_webhook: true,",
  );

  const oldFields = 'const requiredFields = ["messages", "message_echoes", "messaging_postbacks", "message_deliveries", "message_reads", "messaging_referrals"];';
  const newFields = 'const requiredFields = ["messages", "message_echoes", "messaging_postbacks", "message_deliveries", "message_reads", "messaging_referrals", "feed"];';
  if (!source.includes(oldFields)) throw new Error("OUTBOUND_COMMENT_FIELDS_ANCHOR_NOT_FOUND");
  source = source.replace(oldFields, newFields);

  const oldSend = `async function sendMeta(item) {
  const token = await pageToken(item.page_id);
  if (!token) throw new Error(\`PAGE_ACCESS_TOKEN_NOT_FOUND_\${item.page_id}\`);
  const message = buildMetaMessage(item);
  return graph(\`\${item.page_id}/messages\`, token, {
    method: "POST",
    body: {
      recipient: { id: String(item.sender_id) },
      messaging_type: "RESPONSE",
      message,
    },
  });
}`;

  const newSend = `async function sendMeta(item) {
  const token = await pageToken(item.page_id);
  if (!token) throw new Error(\`PAGE_ACCESS_TOKEN_NOT_FOUND_\${item.page_id}\`);
  const message = buildMetaMessage(item);
  const deliveryMode = String(item.payload?.delivery_mode || "");
  const commentId = String(item.payload?.comment_id || "").trim();

  if (deliveryMode === "comment_private_reply") {
    if (!commentId) throw new Error("COMMENT_PRIVATE_REPLY_ID_MISSING");
    return graph(\`\${item.page_id}/messages\`, token, {
      method: "POST",
      body: {
        recipient: { comment_id: commentId },
        message,
      },
    });
  }

  return graph(\`\${item.page_id}/messages\`, token, {
    method: "POST",
    body: {
      recipient: { id: String(item.sender_id) },
      messaging_type: "RESPONSE",
      message,
    },
  });
}`;

  if (!source.includes(oldSend)) throw new Error("OUTBOUND_COMMENT_SEND_ANCHOR_NOT_FOUND");
  source = source.replace(oldSend, newSend);

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`OUTBOUND_COMMENT_PRIVATE_REPLY_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Comment-to-Messenger private reply transport installed");
}
