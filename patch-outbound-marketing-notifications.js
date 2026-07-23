import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "outbound-worker.js";
const marker = "AIGUKA_MARKETING_NOTIFICATIONS_V1";
let source = fs.readFileSync(file, "utf8");

if (source.includes(marker)) {
  console.log("[AIGUKA] Marketing notification transport already installed");
} else {
  const oldVersion = 'const WORKER_VERSION = "production_v5_drive_image_proxy"; // AIGUKA_HUMAN_TAKEOVER_PREFLIGHT_V1 AIGUKA_COMMENT_PRIVATE_REPLY_V1 AIGUKA_BINARY_IMAGE_UPLOAD_V1 AIGUKA_DRIVE_IMAGE_PROXY_V2';
  const newVersion = 'const WORKER_VERSION = "production_v6_marketing_notifications"; // AIGUKA_HUMAN_TAKEOVER_PREFLIGHT_V1 AIGUKA_COMMENT_PRIVATE_REPLY_V1 AIGUKA_BINARY_IMAGE_UPLOAD_V1 AIGUKA_DRIVE_IMAGE_PROXY_V2 AIGUKA_MARKETING_NOTIFICATIONS_V1';
  if (!source.includes(oldVersion)) throw new Error("OUTBOUND_MARKETING_VERSION_ANCHOR_NOT_FOUND");
  source = source.replace(oldVersion, newVersion);

  const oldFields = 'const requiredFields = ["messages", "message_echoes", "messaging_postbacks", "message_deliveries", "message_reads", "messaging_referrals", "feed"];';
  const newFields = 'const requiredFields = ["messages", "message_echoes", "messaging_postbacks", "messaging_optins", "messaging_optouts", "message_deliveries", "message_reads", "messaging_referrals", "feed"];';
  if (!source.includes(oldFields)) throw new Error("OUTBOUND_MARKETING_FIELDS_ANCHOR_NOT_FOUND");
  source = source.replace(oldFields, newFields);

  const standardSend = `  return graph(\`\${item.page_id}/messages\`, token, {
    method: "POST",
    body: {
      recipient: { id: String(item.sender_id) },
      messaging_type: "RESPONSE",
      message,
    },
  });`;
  const notificationSend = `  const notificationToken = String(item.payload?.notification_messages_token || "").trim();
  if (deliveryMode === "notification_messages" || notificationToken) {
    if (!notificationToken) throw new Error("NOTIFICATION_MESSAGES_TOKEN_MISSING");
    return graph(\`\${item.page_id}/messages\`, token, {
      method: "POST",
      body: {
        recipient: { notification_messages_token: notificationToken },
        message,
      },
    });
  }

${standardSend}`;
  if (!source.includes(standardSend)) throw new Error("OUTBOUND_MARKETING_SEND_ANCHOR_NOT_FOUND");
  source = source.replace(standardSend, notificationSend);

  const oldCapability = `        image_proxy: true,
        carousel: true,`;
  const newCapability = `        image_proxy: true,
        carousel: true,
        marketing_notifications: true,
        marketing_optin_webhook: true,`;
  if (source.includes(oldCapability)) source = source.replace(oldCapability, newCapability);

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`OUTBOUND_MARKETING_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Marketing messages now use verified notification_messages_token recipients");
}
