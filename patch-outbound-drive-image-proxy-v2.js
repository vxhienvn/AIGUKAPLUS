import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "outbound-worker.js";
const marker = "AIGUKA_DRIVE_IMAGE_PROXY_V2";
let source = fs.readFileSync(file, "utf8");

if (source.includes(marker)) {
  console.log("[AIGUKA] Drive image proxy transport already installed");
} else {
  source = source.replace(
    'const WORKER_VERSION = "production_v4_binary_image_upload"; // AIGUKA_HUMAN_TAKEOVER_PREFLIGHT_V1 AIGUKA_COMMENT_PRIVATE_REPLY_V1 AIGUKA_BINARY_IMAGE_UPLOAD_V1',
    'const WORKER_VERSION = "production_v5_drive_image_proxy"; // AIGUKA_HUMAN_TAKEOVER_PREFLIGHT_V1 AIGUKA_COMMENT_PRIVATE_REPLY_V1 AIGUKA_BINARY_IMAGE_UPLOAD_V1 AIGUKA_DRIVE_IMAGE_PROXY_V2',
  );

  const oldImageBlock = `  let message;
  if (item.message_type === "image") {
    const payload = item.payload || {};
    const sourceUrl = String(payload.url || payload.image_url || "").trim();
    if (!sourceUrl) throw new Error("EMPTY_IMAGE_URL");
    const asset = await fetchImageAsset(sourceUrl);
    const attachmentId = await uploadMessengerAttachment(item.page_id, token, asset);
    message = { attachment: { type: "image", payload: { attachment_id: attachmentId } } };
  } else {
    message = buildMetaMessage(item);
  }`;

  const newImageBlock = `  let message;
  if (item.message_type === "image") {
    const payload = item.payload || {};
    const sourceUrl = String(payload.url || payload.image_url || "").trim();
    if (!sourceUrl) throw new Error("EMPTY_IMAGE_URL");
    const fileId = extractDriveFileId(sourceUrl);
    const deliveryUrl = fileId
      ? \`\${SUPABASE_URL}/functions/v1/aiguka-drive-image-proxy?file_id=\${encodeURIComponent(fileId)}\`
      : sourceUrl;
    message = { attachment: { type: "image", payload: { url: deliveryUrl, is_reusable: true } } };
  } else {
    message = buildMetaMessage(item);
  }`;

  if (!source.includes(oldImageBlock)) throw new Error("OUTBOUND_DRIVE_PROXY_IMAGE_ANCHOR_NOT_FOUND");
  source = source.replace(oldImageBlock, newImageBlock);

  const oldCapability = `        image: true,
        carousel: true,`;
  const newCapability = `        image: true,
        image_proxy: true,
        carousel: true,`;
  if (source.includes(oldCapability)) source = source.replace(oldCapability, newCapability);

  const oldFailureBlock = `  } catch (error) {
    console.error(\`[AIGUKA outbound] \${item.id}:\`, error.message);
    await rpc("v8_fail_outbound", { p_outbound_id: item.id, p_worker_name: WORKER_NAME, p_error: String(error.message).slice(0, 500), p_retry_seconds: 30 }).catch(() => {});
  }`;
  const newFailureBlock = `  } catch (error) {
    const details = error?.details ? \` | \${JSON.stringify(error.details).slice(0, 650)}\` : "";
    const diagnostic = \`\${String(error?.message || error)}\${details}\`.slice(0, 800);
    console.error(\`[AIGUKA outbound] \${item.id}:\`, diagnostic);
    await rpc("v8_fail_outbound", { p_outbound_id: item.id, p_worker_name: WORKER_NAME, p_error: diagnostic, p_retry_seconds: 30 }).catch(() => {});
  }`;
  if (source.includes(oldFailureBlock)) source = source.replace(oldFailureBlock, newFailureBlock);

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`OUTBOUND_DRIVE_PROXY_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Messenger images now use the verified Supabase Drive image proxy URL");
}
