import crypto from "node:crypto";
import express from "express";

const esc = (value = "") => String(value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const clean = (value = "") => String(value ?? "").trim();
const idFromUrl = (value) => clean(value).match(/(?:folders\/|\/d\/|[?&]id=)([-\w]+)/)?.[1] || clean(value);
const isFolder = (mime = "") => mime === "application/vnd.google-apps.folder";
const isImage = (mime = "") => /^image\//i.test(mime);

export function installDriveSlideManagerV3(app, { supabaseUrl, publishableKey, serviceRoleKey }) {
  const key = serviceRoleKey || publishableKey;
  if (!supabaseUrl || !key) throw new Error("DRIVE_MANAGER_SUPABASE_NOT_CONFIGURED");
  const encryptionKey = crypto.createHash("sha256").update(`${serviceRoleKey || key}|${supabaseUrl}|AIGUKA_GOOGLE_DRIVE_OAUTH_V1`).digest();
  const encrypt = (value) => {
    if (!value) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
    const data = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
  };
  const decrypt = (value) => {
    if (!value) return "";
    const parts = String(value).split(".");
    if (parts.length !== 3) return String(value);
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(parts[0], "base64"));
    decipher.setAuthTag(Buffer.from(parts[1], "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64")), decipher.final()]).toString("utf8");
  };
  const db = async (path, init = {}) => {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", prefer: "return=representation", ...(init.headers || {}) },
      signal: AbortSignal.timeout(init.timeout || 30000),
    });
    const text = await response.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error(data?.message || data?.hint || `SUPABASE_${response.status}`);
    return data;
  };
  const getConnection = async () => (await db("v8_google_drive_connections?connection_key=eq.google_drive&select=*&limit=1"))?.[0] || null;
  const saveConnection = async (row) => (await db("v8_google_drive_connections?on_conflict=connection_key", {
    method: "POST", headers: { prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ connection_key: "google_drive", ...row, updated_at: new Date().toISOString() }),
  }))?.[0] || null;
  const modeOf = (row) => clean(row?.client_id) === "aiguka_v7_api_key" ? "api_key" : (row?.client_id ? "oauth" : "none");
  const apiKeyOf = (row) => modeOf(row) === "api_key" ? decrypt(row.client_secret_ciphertext) : "";
  const publicConnection = (row) => ({
    mode: modeOf(row), configured: Boolean(row?.client_id && row?.client_secret_ciphertext),
    connected: row?.is_enabled !== false && ["connected", "configured"].includes(row?.connection_status) && Boolean(row?.root_folder_id || row?.refresh_token_ciphertext || row?.access_token_ciphertext),
    enabled: row?.is_enabled !== false, status: row?.connection_status || "not_configured",
    root_folder_id: row?.root_folder_id || "", account_email: row?.account_email || "", account_name: row?.account_name || "",
    api_key_hint: modeOf(row) === "api_key" && row?.client_secret_hint ? row.client_secret_hint : "",
    oauth_client_hint: modeOf(row) === "oauth" ? row?.client_id || "" : "", last_error: row?.last_error || null,
    can_write: Boolean(row?.refresh_token_ciphertext || row?.access_token_ciphertext), last_checked_at: row?.last_checked_at || null,
  });
  const requestOrigin = (request) => clean(process.env.PUBLIC_BASE_URL).replace(/\/$/, "") || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `${request.get("x-forwarded-proto") || request.protocol || "https"}://${request.get("host")}`);
  const callbackUrl = (request) => `${requestOrigin(request)}/api/slide-manager/google/callback`;
  const signState = () => {
    const payload = Buffer.from(JSON.stringify({ t: Date.now(), n: crypto.randomBytes(10).toString("hex") })).toString("base64url");
    return `${payload}.${crypto.createHmac("sha256", encryptionKey).update(payload).digest("base64url")}`;
  };
  const verifyState = (state) => {
    const [payload, signature] = clean(state).split("."); if (!payload || !signature) return false;
    const expected = crypto.createHmac("sha256", encryptionKey).update(payload).digest();
    const actual = Buffer.from(signature, "base64url"); if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
    try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).t > Date.now() - 15 * 60_000; } catch { return false; }
  };
  const accessToken = async (row, force = false) => {
    if (!row || modeOf(row) !== "oauth" || row.is_enabled === false) return "";
    const current = decrypt(row.access_token_ciphertext);
    const expires = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
    if (!force && current && expires > Date.now() + 90000) return current;
    const refresh = decrypt(row.refresh_token_ciphertext); if (!refresh) return current;
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: row.client_id, client_secret: decrypt(row.client_secret_ciphertext), refresh_token: refresh, grant_type: "refresh_token" }), signal: AbortSignal.timeout(20000) });
    const data = await response.json().catch(() => ({})); if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || `GOOGLE_OAUTH_${response.status}`);
    await saveConnection({ access_token_ciphertext: encrypt(data.access_token), token_expires_at: new Date(Date.now() + Number(data.expires_in || 3600) * 1000).toISOString(), connection_status: "connected", last_error: null });
    return data.access_token;
  };
  const driveRequest = async (row, path, { method = "GET", body, query = {} } = {}) => {
    const apiKey = apiKeyOf(row); const token = await accessToken(row).catch(() => "");
    if (!apiKey && !token) throw new Error("Chưa cấu hình API key hoặc đăng nhập Google Drive");
    const params = new URLSearchParams(query); if (apiKey) params.set("key", apiKey);
    const response = await fetch(`https://www.googleapis.com/drive/v3/${path}${params.size ? `?${params}` : ""}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error?.message || `GOOGLE_DRIVE_${response.status}`); return data;
  };
  const verifyConnection = async (row) => {
    const root = idFromUrl(row?.root_folder_id); if (!root) throw new Error("Cần nhập link hoặc ID thư mục gốc");
    const info = await driveRequest(row, `files/${encodeURIComponent(root)}`, { query: { fields: "id,name,mimeType,webViewLink,owners(displayName,emailAddress)", supportsAllDrives: "true" } });
    if (!isFolder(info.mimeType)) throw new Error("ID đã nhập không phải thư mục Google Drive");
    return info;
  };
  const listFolder = async (row, folderId) => {
    const result = await driveRequest(row, "files", { query: { q: `'${idFromUrl(folderId)}' in parents and trashed=false`, fields: "files(id,name,mimeType,webViewLink,webContentLink,thumbnailLink,size,createdTime,modifiedTime,parents),nextPageToken", pageSize: "1000", orderBy: "folder,name", supportsAllDrives: "true", includeItemsFromAllDrives: "true" } });
    return (result.files || []).sort((a, b) => Number(!isFolder(a.mimeType)) - Number(!isFolder(b.mimeType)) || String(a.name).localeCompare(String(b.name), "vi"));
  };
  const graphToken = () => process.env.META_PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || process.env.META_USER_ACCESS_TOKEN || "";
  const pageToken = async (pageId) => {
    if (process.env.META_PAGE_ACCESS_TOKEN) return process.env.META_PAGE_ACCESS_TOKEN;
    const token = graphToken(); if (!token) return "";
    const response = await fetch(`https://graph.facebook.com/v23.0/me/accounts?fields=id,access_token&limit=200&access_token=${encodeURIComponent(token)}`);
    const data = await response.json(); return (data.data || []).find((x) => String(x.id) === String(pageId))?.access_token || "";
  };

  const router = express.Router(); router.use(express.json({ limit: "10mb" }));
  router.get("/data", async (req, res) => {
    try {
      const [mappings, assets, pages, recipients, connection] = await Promise.all([
        db("v8_slide_mapping?select=*&order=priority.asc,product_name.asc"), db("v8_drive_assets?select=*&deleted_from_drive_at=is.null&order=product_key.asc,sort_order.asc"),
        db("v8_pages?select=page_id,page_name,is_active&is_active=eq.true&order=page_name.asc"), db("v8_runtime_test_recipients?select=*&is_active=eq.true&order=label.asc"), getConnection().catch(() => null),
      ]);
      res.json({ ok: true, mappings: mappings || [], assets: assets || [], pages: pages || [], recipients: recipients || [], drive_connection: publicConnection(connection), meta_connected: Boolean(graphToken()) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  router.post("/google/api-key", async (req, res) => {
    try {
      const apiKey = clean(req.body?.api_key); const root = idFromUrl(req.body?.root_folder_id); const old = await getConnection();
      if (!apiKey && modeOf(old) !== "api_key") throw new Error("Cần nhập Google Drive API key"); if (!root) throw new Error("Cần nhập link hoặc ID thư mục gốc");
      const row = { ...(old || {}), client_id: "aiguka_v7_api_key", client_secret_ciphertext: apiKey ? encrypt(apiKey) : old.client_secret_ciphertext, client_secret_hint: apiKey ? `••••${apiKey.slice(-6)}` : old.client_secret_hint, root_folder_id: root, is_enabled: true, connection_status: "configured", access_token_ciphertext: null, refresh_token_ciphertext: null, token_expires_at: null, last_error: null };
      const info = await verifyConnection(row); const saved = await saveConnection({ ...row, connection_status: "connected", account_name: info.name || "Google Drive", account_email: info.owners?.[0]?.emailAddress || null, last_checked_at: new Date().toISOString(), metadata: { connection_mode: "api_key", root_folder_name: info.name } });
      res.json({ ok: true, data: publicConnection(saved), root: info });
    } catch (e) { await saveConnection({ connection_status: "error", last_error: e.message }).catch(() => {}); res.status(400).json({ ok: false, error: e.message }); }
  });
  router.post("/google/oauth-config", async (req, res) => {
    try {
      const old = await getConnection(); const clientId = clean(req.body?.client_id); const secret = clean(req.body?.client_secret); const root = idFromUrl(req.body?.root_folder_id || old?.root_folder_id);
      if (!clientId) throw new Error("Cần nhập OAuth Client ID"); if (!secret && modeOf(old) !== "oauth") throw new Error("Cần nhập OAuth Client Secret");
      const saved = await saveConnection({ client_id: clientId, client_secret_ciphertext: secret ? encrypt(secret) : old.client_secret_ciphertext, client_secret_hint: secret ? `••••${secret.slice(-4)}` : old.client_secret_hint, root_folder_id: root || null, is_enabled: true, connection_status: "configured", access_token_ciphertext: modeOf(old) === "oauth" ? old.access_token_ciphertext : null, refresh_token_ciphertext: modeOf(old) === "oauth" ? old.refresh_token_ciphertext : null, last_error: null });
      res.json({ ok: true, data: publicConnection(saved), callback_url: callbackUrl(req) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  router.get("/google/connect", async (req, res) => {
    try {
      const row = await getConnection(); if (modeOf(row) !== "oauth" || !row.client_secret_ciphertext) throw new Error("Chưa lưu cấu hình OAuth Google");
      const params = new URLSearchParams({ client_id: row.client_id, redirect_uri: callbackUrl(req), response_type: "code", access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true", scope: "https://www.googleapis.com/auth/drive", state: signState() });
      res.json({ ok: true, authorization_url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  router.get("/google/callback", async (req, res) => {
    try {
      if (req.query.error) throw new Error(clean(req.query.error_description || req.query.error)); if (!verifyState(req.query.state)) throw new Error("Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn");
      const row = await getConnection(); const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: clean(req.query.code), client_id: row.client_id, client_secret: decrypt(row.client_secret_ciphertext), redirect_uri: callbackUrl(req), grant_type: "authorization_code" }), signal: AbortSignal.timeout(20000) });
      const data = await response.json().catch(() => ({})); if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || `GOOGLE_OAUTH_${response.status}`);
      await saveConnection({ access_token_ciphertext: encrypt(data.access_token), refresh_token_ciphertext: data.refresh_token ? encrypt(data.refresh_token) : row.refresh_token_ciphertext, token_expires_at: new Date(Date.now() + Number(data.expires_in || 3600) * 1000).toISOString(), connection_status: "connected", is_enabled: true, last_error: null });
      res.redirect(302, "/drive-slides?tab=google&google=connected");
    } catch (e) { await saveConnection({ connection_status: "error", last_error: e.message }).catch(() => {}); res.redirect(302, `/drive-slides?tab=google&google=error&message=${encodeURIComponent(e.message)}`); }
  });
  router.post("/google/test", async (_req, res) => {
    try { const row = await getConnection(); const info = await verifyConnection(row); const saved = await saveConnection({ connection_status: "connected", account_name: row.account_name || info.name, account_email: row.account_email || info.owners?.[0]?.emailAddress || null, last_checked_at: new Date().toISOString(), last_error: null }); res.json({ ok: true, data: publicConnection(saved), root: info }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  router.get("/drive/list", async (req, res) => {
    try { const row = await getConnection(); const folderId = idFromUrl(req.query.folder_id || row?.root_folder_id); if (!folderId) throw new Error("Chưa có thư mục gốc"); res.json({ ok: true, folder_id: folderId, items: await listFolder(row, folderId), connection: publicConnection(row) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  router.post("/drive/sync", async (req, res) => {
    try {
      const row = await getConnection(); const mappingId = clean(req.body?.mapping_id); const mappings = mappingId ? await db(`v8_slide_mapping?id=eq.${encodeURIComponent(mappingId)}&select=*&limit=1`) : [];
      const mapping = mappings?.[0]; const productKey = clean(req.body?.product_key || mapping?.product_key); const folderId = idFromUrl(req.body?.folder_id || mapping?.drive_folder_id || mapping?.drive_folder_url || row?.root_folder_id);
      if (!productKey || !folderId) throw new Error("Thiếu mã sản phẩm hoặc thư mục Drive"); const items = await listFolder(row, folderId); const images = items.filter((x) => isImage(x.mimeType));
      let count = 0; for (const [index, item] of images.entries()) { await db("v8_drive_assets?on_conflict=drive_file_id", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ product_key: productKey, product_name: mapping?.product_name || productKey, catalog_key: productKey, root_folder_url: `https://drive.google.com/drive/folders/${folderId}`, parent_folder_id: folderId, parent_folder_name: mapping?.product_name || "", parent_folder_url: `https://drive.google.com/drive/folders/${folderId}`, drive_file_id: item.id, file_name: item.name, mime_type: item.mimeType, file_url: item.webViewLink || `https://drive.google.com/file/d/${item.id}/view`, delivery_url: `https://drive.google.com/uc?export=view&id=${item.id}`, file_size: item.size ? Number(item.size) : null, created_time: item.createdTime || null, modified_time: item.modifiedTime || null, sort_order: index + 1, is_image: true, is_active: true, last_seen_at: new Date().toISOString(), deleted_from_drive_at: null }) }); count++; }
      if (mappingId) await db(`v8_slide_mapping?id=eq.${encodeURIComponent(mappingId)}`, { method: "PATCH", body: JSON.stringify({ drive_folder_id: folderId, drive_folder_url: `https://drive.google.com/drive/folders/${folderId}`, sync_status: "success", last_synced_at: new Date().toISOString(), sync_error: null }) });
      res.json({ ok: true, synced: count, total_items: items.length });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  router.post("/drive/folder", async (req, res) => {
    try { const row = await getConnection(); if (!publicConnection(row).can_write) throw new Error("Tạo thư mục cần đăng nhập Google OAuth; API key chỉ đọc và đồng bộ"); const name = clean(req.body?.name); if (!name) throw new Error("Cần nhập tên thư mục"); const body = { name, mimeType: "application/vnd.google-apps.folder", ...(req.body?.parent_id ? { parents: [idFromUrl(req.body.parent_id)] } : {}) }; res.json({ ok: true, data: await driveRequest(row, "files", { method: "POST", body, query: { fields: "id,name,webViewLink" } }) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  router.post("/mapping", async (req, res) => {
    try { const b = req.body || {}; const productKey = clean(b.product_key); const folderId = idFromUrl(b.drive_folder_url); if (!productKey || !folderId) throw new Error("Cần nhập mã sản phẩm và thư mục Drive"); const row = { page_id: clean(b.page_id) || null, product_key: productKey, product_name: clean(b.product_name || productKey), slide_title: clean(b.slide_title || `Slide ${b.product_name || productKey}`), slide_url: `https://drive.google.com/drive/folders/${folderId}`, drive_folder_url: `https://drive.google.com/drive/folders/${folderId}`, drive_folder_id: folderId, priority: Number(b.priority || 100), is_active: b.is_active !== false, note: clean(b.note) || null, updated_at: new Date().toISOString() }; const result = b.id ? await db(`v8_slide_mapping?id=eq.${encodeURIComponent(b.id)}`, { method: "PATCH", body: JSON.stringify(row) }) : await db("v8_slide_mapping", { method: "POST", body: JSON.stringify(row) }); res.json({ ok: true, data: result?.[0] || null }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  router.delete("/mapping/:id", async (req, res) => { try { await db(`v8_slide_mapping?id=eq.${encodeURIComponent(req.params.id)}`, { method: "DELETE" }); res.json({ ok: true }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });
  router.get("/image/:id", async (req, res) => {
    try { const asset = (await db(`v8_drive_assets?id=eq.${encodeURIComponent(req.params.id)}&select=*&limit=1`))?.[0]; if (!asset) throw new Error("Không tìm thấy ảnh"); const row = await getConnection(); const token = await accessToken(row).catch(() => ""); const url = token ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(asset.drive_file_id)}?alt=media` : asset.delivery_url; const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: "follow", signal: AbortSignal.timeout(20000) }); const type = response.headers.get("content-type") || ""; if (!response.ok || !type.startsWith("image/")) throw new Error(`Ảnh không đọc được: HTTP ${response.status}`); const buffer = Buffer.from(await response.arrayBuffer()); res.set({ "content-type": type, "cache-control": "public,max-age=300", "content-length": String(buffer.length) }); res.send(buffer); }
    catch (e) { res.status(404).json({ ok: false, error: e.message }); }
  });
  router.post("/test-slide", async (req, res) => {
    try { const mapping = (await db(`v8_slide_mapping?id=eq.${encodeURIComponent(req.body?.mapping_id)}&select=*&limit=1`))?.[0]; if (!mapping) throw new Error("Không tìm thấy mapping"); const assets = await db(`v8_drive_assets?product_key=eq.${encodeURIComponent(mapping.product_key)}&is_active=eq.true&deleted_from_drive_at=is.null&select=*&order=sort_order.asc&limit=10`); if (!assets?.length) throw new Error("Mapping chưa có ảnh; hãy đồng bộ thư mục Drive trước"); const recipient = clean(req.body?.recipient_id); if (!/^\d{5,32}$/.test(recipient)) throw new Error("PSID không hợp lệ"); const token = await pageToken(req.body?.page_id); if (!token) throw new Error("Không tìm thấy Page Access Token"); const results = []; for (const asset of assets) { const url = `${requestOrigin(req)}/api/slide-manager/image/${asset.id}`; const response = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(req.body.page_id)}/messages?access_token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipient: { id: recipient }, messaging_type: "RESPONSE", message: { attachment: { type: "image", payload: { url, is_reusable: true } } } }) }); const data = await response.json(); results.push(response.ok ? { ok: true, file_name: asset.file_name, message_id: data.message_id } : { ok: false, file_name: asset.file_name, error: data.error?.message || `META_${response.status}` }); } const success = results.filter((x) => x.ok).length; res.json({ ok: true, all_sent: success === results.length, total: results.length, success_count: success, failure_count: results.length - success, results }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  app.use("/api/slide-manager", router);
  app.get("/drive-slides", (_req, res) => res.type("html").send(pageHtml()));
}

function pageHtml() { return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mapping, Google Drive và chạy thử slide</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#172033;font:14px Arial,sans-serif}.wrap{max-width:1540px;margin:auto;padding:20px}.top,.panel{background:#fff;border:1px solid #c8d5e5;border-radius:11px;padding:15px;margin-bottom:13px}.top{display:flex;justify-content:space-between;align-items:center}.tabs,.actions{display:flex;gap:7px;flex-wrap:wrap}.tabs{margin-bottom:13px}button,input,select{border:1px solid #b8c8dc;border-radius:6px;padding:8px;background:#fff;font:inherit}button{cursor:pointer}.active,.primary{background:#1e5fd5!important;color:#fff;border-color:#1e5fd5!important}.hide{display:none!important}.status{padding:10px 12px;border:1px solid #86b4eb;background:#edf6ff;border-radius:7px;margin-bottom:13px}.status.bad{border-color:#ef9a9a;background:#fff0f0;color:#a61b1b}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.wide{grid-column:span 2}label{display:block;font-weight:700;font-size:12px;margin-bottom:5px}input,select{width:100%}table{width:100%;border-collapse:collapse}th,td{border:1px solid rgba(84,118,158,.34);padding:8px;text-align:left;vertical-align:top}th{background:rgba(46,91,145,.14);color:#1f3c61}tbody tr:nth-child(even){background:rgba(225,235,247,.28)}.table{overflow:auto}.notice{padding:10px;border:1px solid #86b4eb;background:#edf6ff;border-radius:7px;margin:9px 0}.card{border:1px solid #c8d5e5;border-radius:8px;padding:11px;background:#fbfdff}.badge{display:inline-block;padding:4px 8px;border-radius:999px;background:#fff1c2}.badge.ok{background:#d8f5e2;color:#075b35}.tree{max-height:500px;overflow:auto}.drive-row{display:grid;grid-template-columns:32px 1fr auto;gap:8px;padding:8px;border-bottom:1px solid #dbe4ef;align-items:center}.drive-row:hover{background:#f1f6fc}.muted{color:#667085}.thumb{width:80px;height:60px;object-fit:cover;border:1px solid #c8d5e5;border-radius:5px}.preview{display:flex;gap:8px;flex-wrap:wrap}.preview figure{margin:0;width:105px;font-size:11px}.preview img{width:105px;height:75px;object-fit:cover}.advanced{margin-top:10px;border:1px dashed #b8c8dc;border-radius:8px;padding:10px}@media(max-width:900px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}.wrap{padding:10px}}
</style></head><body><div class="wrap"><div class="top"><div><h1>Mapping, Google Drive và chạy thử slide</h1><div class="muted">Đọc thư mục Drive, đồng bộ ảnh và gửi thử qua Meta.</div></div><a href="/dashboard">Về bảng điều khiển</a></div><div id="status" class="status">Đang tải dữ liệu…</div><div class="tabs"><button class="active" data-tab="mapping">Mapping</button><button data-tab="drive">Thư mục & tệp Drive</button><button data-tab="test">Chạy thử slide</button><button data-tab="google">Kết nối Google Drive</button></div>
<section id="mapping" class="panel tab"><h2>Mapping sản phẩm → thư mục Drive</h2><form id="mapping-form" class="grid"><input type="hidden" name="id"><div><label>Mã sản phẩm</label><input name="product_key" required></div><div><label>Tên sản phẩm</label><input name="product_name" required></div><div class="wide"><label>Link/ID thư mục Drive</label><input name="drive_folder_url" required></div><div><label>Page</label><select name="page_id" id="mapping-page"></select></div><div><label>Ưu tiên</label><input name="priority" type="number" value="100"></div><div class="wide"><label>Ghi chú</label><input name="note"></div><div class="actions"><button class="primary">Lưu mapping</button><button type="button" id="mapping-new">Thêm mới</button></div></form><div class="table" style="margin-top:12px"><table><thead><tr><th>Sản phẩm</th><th>Thư mục</th><th>Page</th><th>Số ảnh</th><th>Thao tác</th></tr></thead><tbody id="mapping-rows"></tbody></table></div></section>
<section id="drive" class="panel tab hide"><h2>Thư mục và tệp Google Drive</h2><div id="drive-connection" class="card"></div><div class="actions" style="margin:10px 0"><button id="drive-root">Về thư mục gốc</button><button id="drive-up">Lên một cấp</button><button id="drive-reload">Tải lại</button><input id="folder-new-name" style="width:240px" placeholder="Tên thư mục mới"><button id="folder-create">+ Tạo thư mục</button></div><div id="breadcrumb" class="muted"></div><div id="drive-list" class="tree card"></div></section>
<section id="test" class="panel tab hide"><h2>Chạy thử slide</h2><div class="grid"><div><label>Page Facebook</label><select id="test-page"></select></div><div><label>PSID người nhận</label><input id="recipient" list="recipient-list"></div><datalist id="recipient-list"></datalist><div><label>Mapping</label><select id="test-mapping"></select></div><div style="align-self:end"><button class="primary" id="run-test">Gửi thử</button></div></div><div id="preview" class="preview" style="margin-top:12px"></div><div id="test-result" class="card" style="margin-top:12px">Chưa chạy thử.</div></section>
<section id="google" class="panel tab hide"><h2>Kết nối Google Drive</h2><div class="notice"><b>Cách đơn giản:</b> nhập API key và link thư mục gốc đã chia sẻ. Không cần thêm Variables trên webhook. API key đọc và đồng bộ ảnh; muốn tạo/xóa trực tiếp trên Drive thì đăng nhập OAuth.</div><div id="google-state" class="card"></div><div class="grid" style="margin-top:12px"><div class="wide"><label>Google Drive API key</label><input id="api-key" type="password" placeholder="AIza… hoặc để trống nếu đã lưu"></div><div class="wide"><label>Link/ID thư mục gốc</label><input id="root-folder"></div><div class="actions"><button class="primary" id="save-api-key">Lưu và kết nối</button><button id="test-connection">Kiểm tra</button></div></div><details class="advanced"><summary><b>Đăng nhập tài khoản Google / đổi tài khoản</b></summary><div class="grid" style="margin-top:10px"><div class="wide"><label>OAuth Client ID</label><input id="oauth-client-id"></div><div class="wide"><label>OAuth Client Secret</label><input id="oauth-client-secret" type="password"></div><div class="wide"><label>Thư mục gốc</label><input id="oauth-root-folder"></div><div class="actions"><button id="save-oauth">Lưu OAuth</button><button class="primary" id="login-google">Đăng nhập / đổi tài khoản</button></div></div><div class="muted" id="callback-info"></div></details></section></div><script>
let D={mappings:[],assets:[],pages:[],recipients:[],drive_connection:{}},folderStack=[];const $=id=>document.getElementById(id),E=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));function status(t,ok=true){$('status').textContent=t;$('status').className='status'+(ok?'':' bad')}async function api(path,opt={}){const r=await fetch('/api/slide-manager'+path,{...opt,headers:{'content-type':'application/json',...(opt.headers||{})}}),t=await r.text();let j;try{j=t?JSON.parse(t):{}}catch{j={error:t}}if(!r.ok||j.ok===false)throw Error(j.error||'Có lỗi xảy ra');return j}function tab(id){document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('hide',x.id!==id));if(id==='test')preview()}function formData(form){return Object.fromEntries(new FormData(form).entries())}function render(){const counts=new Map();D.assets.filter(x=>x.is_active).forEach(x=>counts.set(x.product_key,(counts.get(x.product_key)||0)+1));$('mapping-rows').innerHTML=D.mappings.map(x=>'<tr><td><b>'+E(x.product_name)+'</b><br><small>'+E(x.product_key)+'</small></td><td>'+E(x.drive_folder_id||'')+'</td><td>'+E(x.page_id||'Tất cả')+'</td><td>'+E(counts.get(x.product_key)||0)+'</td><td><button data-edit="'+E(x.id)+'">Sửa</button> <button data-sync="'+E(x.id)+'">Đồng bộ</button> <button data-del="'+E(x.id)+'">Xóa</button></td></tr>').join('')||'<tr><td colspan="5">Chưa có mapping.</td></tr>';$('mapping-page').innerHTML='<option value="">Tất cả Page</option>'+D.pages.map(x=>'<option value="'+E(x.page_id)+'">'+E(x.page_name)+'</option>').join('');$('test-page').innerHTML=D.pages.map(x=>'<option value="'+E(x.page_id)+'">'+E(x.page_name)+'</option>').join('');$('test-mapping').innerHTML=D.mappings.map(x=>'<option value="'+E(x.id)+'">'+E(x.product_name)+'</option>').join('');$('recipient-list').innerHTML=D.recipients.map(x=>'<option value="'+E(x.sender_id)+'">'+E(x.label||x.sender_id)+'</option>').join('');const c=D.drive_connection||{};$('google-state').innerHTML='<b>Trạng thái: '+E(c.connected?'Đã kết nối':'Chưa kết nối')+'</b> · Chế độ '+E(c.mode||'none')+(c.account_email?' · '+E(c.account_email):'')+(c.last_error?'<div style="color:#b42318">'+E(c.last_error)+'</div>':'');$('drive-connection').innerHTML=$('google-state').innerHTML;$('root-folder').value=c.root_folder_id||'';$('oauth-root-folder').value=c.root_folder_id||'';$('api-key').placeholder=c.api_key_hint?'Đã lưu '+c.api_key_hint:'Nhập API key';$('folder-create').disabled=!c.can_write;preview()}
async function load(){status('Đang tải mapping, ảnh và kết nối…');D=await api('/data');render();status('Đã tải '+D.mappings.length+' mapping và '+D.assets.length+' ảnh.');if(D.drive_connection?.connected){folderStack=[];await listFolder(D.drive_connection.root_folder_id)}}async function listFolder(id,name){if(!id)return;status('Đang tải thư mục Drive…');const j=await api('/drive/list?folder_id='+encodeURIComponent(id));if(!folderStack.length||folderStack.at(-1).id!==id)folderStack.push({id,name:name||id});$('breadcrumb').textContent=folderStack.map(x=>x.name).join(' / ');$('drive-list').innerHTML=j.items.map(x=>'<div class="drive-row"><span>'+(x.mimeType==='application/vnd.google-apps.folder'?'📁':'🖼️')+'</span><div><b>'+E(x.name)+'</b><br><small>'+E(x.mimeType)+'</small></div><div>'+(x.mimeType==='application/vnd.google-apps.folder'?'<button data-open-folder="'+E(x.id)+'" data-folder-name="'+E(x.name)+'">Mở</button>':'<a target="_blank" href="'+E(x.webViewLink||'#')+'">Xem</a>')+'</div></div>').join('')||'<div class="muted">Thư mục trống.</div>';status('Đã tải '+j.items.length+' mục.')}function preview(){const m=D.mappings.find(x=>x.id===$('test-mapping').value)||D.mappings[0];const a=D.assets.filter(x=>m&&x.product_key===m.product_key&&x.is_active).slice(0,10);$('preview').innerHTML=a.map(x=>'<figure><img src="/api/slide-manager/image/'+E(x.id)+'"><figcaption>'+E(x.file_name)+'</figcaption></figure>').join('')||'<span class="muted">Chưa có ảnh; hãy đồng bộ thư mục Drive.</span>'}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>tab(b.dataset.tab));$('mapping-new').onclick=()=>{$('mapping-form').reset();$('mapping-form').elements.id.value=''};$('mapping-form').onsubmit=async e=>{e.preventDefault();try{status('Đang lưu mapping…');await api('/mapping',{method:'POST',body:JSON.stringify(formData(e.currentTarget))});await load()}catch(x){status(x.message,false)}};$('mapping-rows').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{if(b.dataset.edit){const x=D.mappings.find(v=>v.id===b.dataset.edit);Object.entries(x||{}).forEach(([k,v])=>{if($('mapping-form').elements[k])$('mapping-form').elements[k].value=v??''});window.scrollTo(0,0)}else if(b.dataset.sync){status('Đang đồng bộ ảnh…');const j=await api('/drive/sync',{method:'POST',body:JSON.stringify({mapping_id:b.dataset.sync})});status('Đã đồng bộ '+j.synced+' ảnh.');await load()}else if(b.dataset.del&&confirm('Xóa mapping này?')){await api('/mapping/'+encodeURIComponent(b.dataset.del),{method:'DELETE'});await load()}}catch(x){status(x.message,false)}};$('drive-list').onclick=e=>{const b=e.target.closest('[data-open-folder]');if(b)listFolder(b.dataset.openFolder,b.dataset.folderName)};$('drive-root').onclick=()=>{folderStack=[];listFolder(D.drive_connection.root_folder_id,'Gốc')};$('drive-up').onclick=()=>{if(folderStack.length>1)folderStack.pop();const x=folderStack.pop()||{id:D.drive_connection.root_folder_id,name:'Gốc'};listFolder(x.id,x.name)};$('drive-reload').onclick=()=>{const x=folderStack.at(-1)||{id:D.drive_connection.root_folder_id};listFolder(x.id,x.name)};$('folder-create').onclick=async()=>{try{const name=$('folder-new-name').value.trim();const parent=folderStack.at(-1)?.id||D.drive_connection.root_folder_id;const j=await api('/drive/folder',{method:'POST',body:JSON.stringify({name,parent_id:parent})});status('Đã tạo thư mục '+j.data.name);$('folder-new-name').value='';await listFolder(parent,folderStack.at(-1)?.name)}catch(x){status(x.message,false)}};$('save-api-key').onclick=async()=>{try{status('Đang lưu và kiểm tra API key…');const j=await api('/google/api-key',{method:'POST',body:JSON.stringify({api_key:$('api-key').value.trim(),root_folder_id:$('root-folder').value.trim()})});D.drive_connection=j.data;render();folderStack=[];await listFolder(j.data.root_folder_id,'Gốc')}catch(x){status(x.message,false)}};$('test-connection').onclick=async()=>{try{const j=await api('/google/test',{method:'POST'});D.drive_connection=j.data;render();status('Kết nối Google Drive hoạt động.')}catch(x){status(x.message,false)}};$('save-oauth').onclick=async()=>{try{const j=await api('/google/oauth-config',{method:'POST',body:JSON.stringify({client_id:$('oauth-client-id').value.trim(),client_secret:$('oauth-client-secret').value.trim(),root_folder_id:$('oauth-root-folder').value.trim()})});D.drive_connection=j.data;$('callback-info').textContent='Redirect URI: '+j.callback_url;render();status('Đã lưu cấu hình OAuth.')}catch(x){status(x.message,false)}};$('login-google').onclick=async()=>{try{const j=await api('/google/connect');location.href=j.authorization_url}catch(x){status(x.message,false)}};$('test-mapping').onchange=preview;$('run-test').onclick=async()=>{try{status('Đang gửi thử slide…');const j=await api('/test-slide',{method:'POST',body:JSON.stringify({page_id:$('test-page').value,recipient_id:$('recipient').value.trim(),mapping_id:$('test-mapping').value})});$('test-result').innerHTML='<b>Đã gửi '+j.success_count+'/'+j.total+' ảnh</b><br>'+j.results.map(x=>(x.ok?'✅ ':'❌ ')+E(x.file_name)+(x.error?' — '+E(x.error):'')).join('<br>');status(j.all_sent?'Gửi thử thành công.':'Có ảnh gửi thất bại.',j.all_sent)}catch(x){status(x.message,false)}};const q=new URLSearchParams(location.search);load().then(()=>{if(q.get('tab'))tab(q.get('tab'));if(q.get('google')==='connected')status('Đã đăng nhập Google thành công.');if(q.get('google')==='error')status(q.get('message')||'Không đăng nhập được Google.',false)}).catch(x=>status(x.message,false));
</script></body></html>`; }
