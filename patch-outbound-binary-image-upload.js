import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "outbound-worker.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_BINARY_IMAGE_UPLOAD_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Binary Messenger image upload already installed");
} else {
  source = source.replace(
    'const WORKER_VERSION = "production_v1";',
    'const WORKER_VERSION = "production_v2_binary_image_upload";',
  );

  const oldBlock = `async function sendMeta(item) {
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

  const newBlock = `// AIGUKA_BINARY_IMAGE_UPLOAD_V1
function extractDriveFileId(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  try {
    const url = new URL(input);
    const queryId = url.searchParams.get("id");
    if (queryId) return queryId;
    const match = url.pathname.match(/\\/d\\/([^/]+)/);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

function sniffImageType(buffer, headerType = "") {
  const declared = String(headerType || "").split(";")[0].trim().toLowerCase();
  if (declared.startsWith("image/")) return declared;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString())) return "image/gif";
  return "";
}

function extensionForType(contentType) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/gif") return "gif";
  return "jpg";
}

async function fetchImageAsset(sourceUrl) {
  const fileId = extractDriveFileId(sourceUrl);
  const candidates = [String(sourceUrl || "").trim()];
  if (fileId) {
    candidates.unshift(
      \`https://drive.usercontent.google.com/download?id=\${encodeURIComponent(fileId)}&export=download&confirm=t\`,
      \`https://drive.google.com/uc?export=download&id=\${encodeURIComponent(fileId)}\`,
    );
  }

  const errors = [];
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    try {
      const response = await fetch(candidate, {
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
        cache: "no-store",
        headers: { "user-agent": "AIGUKA/1.0" },
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = sniffImageType(buffer, response.headers.get("content-type"));
      if (!response.ok) throw new Error(\`HTTP_\${response.status}\`);
      if (!contentType) throw new Error(\`NOT_IMAGE_\${response.headers.get("content-type") || "unknown"}\`);
      if (buffer.length < 32) throw new Error("IMAGE_TOO_SMALL");
      const filename = \`aiguka-\${Date.now()}.\${extensionForType(contentType)}\`;
      return { blob: new Blob([buffer], { type: contentType }), filename, contentType, sourceUrl: candidate };
    } catch (error) {
      errors.push(\`\${candidate}:\${error.message}\`);
    }
  }
  throw new Error(\`IMAGE_FETCH_FAILED: \${errors.join(" | ").slice(0, 700)}\`);
}

async function uploadMessengerAttachment(pageId, token, asset) {
  const uploadUrl = new URL(\`https://graph.facebook.com/\${GRAPH_VERSION}/\${pageId}/message_attachments\`);
  uploadUrl.searchParams.set("access_token", token);
  const form = new FormData();
  form.set("message", JSON.stringify({ attachment: { type: "image", payload: { is_reusable: true } } }));
  form.set("filedata", asset.blob, asset.filename);

  const response = await fetch(uploadUrl, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(45_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok || data?.error) {
    const error = new Error(data?.error?.message || \`META_ATTACHMENT_UPLOAD_HTTP_\${response.status}\`);
    error.code = data?.error?.code;
    error.details = data?.error || data;
    throw error;
  }
  if (!data?.attachment_id) throw new Error("META_ATTACHMENT_ID_MISSING");
  return String(data.attachment_id);
}

async function sendMeta(item) {
  const token = await pageToken(item.page_id);
  if (!token) throw new Error(\`PAGE_ACCESS_TOKEN_NOT_FOUND_\${item.page_id}\`);

  let message;
  if (item.message_type === "image") {
    const payload = item.payload || {};
    const sourceUrl = String(payload.url || payload.image_url || "").trim();
    if (!sourceUrl) throw new Error("EMPTY_IMAGE_URL");
    const asset = await fetchImageAsset(sourceUrl);
    const attachmentId = await uploadMessengerAttachment(item.page_id, token, asset);
    message = { attachment: { type: "image", payload: { attachment_id: attachmentId } } };
  } else {
    message = buildMetaMessage(item);
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

  if (!source.includes(oldBlock)) throw new Error("OUTBOUND_IMAGE_UPLOAD_ANCHOR_NOT_FOUND");
  source = source.replace(oldBlock, newBlock);
  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`OUTBOUND_IMAGE_UPLOAD_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Messenger images now use binary Attachment Upload API");
}
