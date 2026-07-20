import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = String(Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const SERVICE_KEY = String(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const MAX_BYTES = 25 * 1024 * 1024;

const commonHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...commonHeaders, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function imageType(bytes: Uint8Array, declared = "") {
  const header = String(declared || "").split(";")[0].trim().toLowerCase();
  if (header.startsWith("image/")) return header;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.slice(0, 6)))) return "image/gif";
  return "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: commonHeaders });
  if (!["GET", "HEAD"].includes(req.method)) return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ ok: false, error: "SERVER_CONFIGURATION_MISSING" }, 503);

  const requestUrl = new URL(req.url);
  const fileId = String(requestUrl.searchParams.get("file_id") || "").trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) return json({ ok: false, error: "INVALID_FILE_ID" }, 400);

  const { data: asset, error: assetError } = await db
    .from("v8_drive_assets")
    .select("drive_file_id,delivery_url,file_url,mime_type,file_name,file_size,is_active,is_image,delivery_status")
    .eq("drive_file_id", fileId)
    .eq("is_active", true)
    .eq("is_image", true)
    .maybeSingle();

  if (assetError) return json({ ok: false, error: "ASSET_LOOKUP_FAILED" }, 502);
  if (!asset || String(asset.delivery_status || "").toLowerCase() === "error") {
    return json({ ok: false, error: "ASSET_NOT_ALLOWED" }, 404);
  }

  const candidates = [...new Set([
    `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`,
    `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}&confirm=t`,
    String(asset.delivery_url || "").trim(),
    String(asset.file_url || "").trim(),
  ].filter(Boolean))];

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        redirect: "follow",
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
        headers: { "user-agent": "AIGUKA-Drive-Image-Proxy/1.0" },
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > MAX_BYTES) throw new Error("IMAGE_TOO_LARGE");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length < 32) throw new Error("IMAGE_TOO_SMALL");
      if (bytes.length > MAX_BYTES) throw new Error("IMAGE_TOO_LARGE");
      const contentType = imageType(bytes, response.headers.get("content-type") || asset.mime_type || "");
      if (!contentType) throw new Error("NOT_AN_IMAGE");

      const responseHeaders = new Headers(commonHeaders);
      responseHeaders.set("content-type", contentType);
      responseHeaders.set("content-length", String(bytes.length));
      responseHeaders.set("content-disposition", `inline; filename="${String(asset.file_name || "aiguka-image").replace(/[\r\n\"]/g, "_")}"`);
      responseHeaders.set("etag", `W/\"${fileId}-${bytes.length}\"`);
      responseHeaders.set("x-aiguka-drive-file-id", fileId);
      return new Response(req.method === "HEAD" ? null : bytes, { status: 200, headers: responseHeaders });
    } catch (error) {
      errors.push(`${candidate}:${String(error?.message || error)}`);
    }
  }

  return json({ ok: false, error: "IMAGE_FETCH_FAILED", attempts: errors.slice(0, 4) }, 502);
});
