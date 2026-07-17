import crypto from "node:crypto";
import express from "express";

const esc = (value = "") => String(value).replace(
  /[&<>"']/g,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
);

const idFromUrl = (value) => (
  String(value || "").match(/(?:folders\/|\/d\/|[?&]id=)([-\w]+)/)?.[1]
  || String(value || "").trim()
);

export function installDriveSlideManager(app, { supabaseUrl, publishableKey, serviceRoleKey }) {
  const key = serviceRoleKey || publishableKey;
  const encryptionKey = crypto.createHash("sha256")
    .update(`${serviceRoleKey || key}|${supabaseUrl}|AIGUKA_GOOGLE_DRIVE_OAUTH_V1`)
    .digest();

  const encrypt = (value) => {
    if (!value) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
  };

  const decrypt = (value) => {
    if (!value) return "";
    const [iv, tag, encrypted] = String(value).split(".");
    if (!iv || !tag || !encrypted) throw new Error("Dữ liệu kết nối Google Drive không hợp lệ");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
  };

  const db = async (path, init = {}) => {
    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        prefer: "return=representation",
        ...(init.headers || {}),
      },
    });
    const responseText = await response.text();
    let data;
    try { data = responseText ? JSON.parse(responseText) : null; } catch { data = responseText; }
    if (!response.ok) throw new Error(data?.message || data?.hint || `SUPABASE_${response.status}`);
    return data;
  };

  const graphToken = () => (
    process.env.META_PAGE_ACCESS_TOKEN
    || process.env.META_ACCESS_TOKEN
    || process.env.META_USER_ACCESS_TOKEN
    || ""
  );
  const pageToken = async (pageId) => {
    if (process.env.META_PAGE_ACCESS_TOKEN) return process.env.META_PAGE_ACCESS_TOKEN;
    const userToken = graphToken();
    if (!userToken) return "";
    const response = await fetch(
      `https://graph.facebook.com/v23.0/me/accounts?fields=id,access_token&limit=200&access_token=${encodeURIComponent(userToken)}`,
    );
    const data = await response.json();
    return (data.data || []).find((page) => String(page.id) === String(pageId))?.access_token || "";
  };

  const requestOrigin = (request) => {
    const configuredOrigin = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
    const forwardedProtocol = String(request.get("x-forwarded-proto") || request.protocol || "https").split(",")[0].trim();
    return configuredOrigin || `${forwardedProtocol}://${request.get("host")}`;
  };
  const driveCallbackUrl = (request) => `${requestOrigin(request)}/api/slide-manager/google/callback`;

  const getDriveConnection = async () => {
    const rows = await db("v8_google_drive_connections?connection_key=eq.google_drive&select=*&limit=1");
    return rows?.[0] || null;
  };

  const safeDriveConnection = (row, request) => ({
    configured: Boolean(row?.client_id && row?.client_secret_ciphertext),
    connected: Boolean(row?.refresh_token_ciphertext || row?.access_token_ciphertext),
    enabled: row?.is_enabled !== false,
    status: row?.connection_status || "not_configured",
    client_id: row?.client_id || "",
    client_secret_hint: row?.client_secret_hint || "",
    root_folder_id: row?.root_folder_id || "",
    account_email: row?.account_email || "",
    account_name: row?.account_name || "",
    scope: row?.scope || "",
    last_checked_at: row?.last_checked_at || null,
    last_error: row?.last_error || null,
    callback_url: driveCallbackUrl(request),
    legacy_variable_active: Boolean(process.env.GOOGLE_DRIVE_ACCESS_TOKEN),
  });

  const saveDriveConnection = async (row) => {
    const result = await db("v8_google_drive_connections?on_conflict=connection_key", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ connection_key: "google_drive", ...row, updated_at: new Date().toISOString() }),
    });
    return result?.[0] || null;
  };

  const refreshDriveAccessToken = async (connection, force = false) => {
    if (!connection || connection.is_enabled === false) return "";
    const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
    const accessToken = decrypt(connection.access_token_ciphertext);
    if (!force && accessToken && expiresAt > Date.now() + 90_000) return accessToken;
    const refreshToken = decrypt(connection.refresh_token_ciphertext);
    if (!refreshToken) return accessToken;
    try {
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: connection.client_id,
          client_secret: decrypt(connection.client_secret_ciphertext),
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const tokenData = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || !tokenData.access_token) {
        throw new Error(tokenData.error_description || tokenData.error || `GOOGLE_OAUTH_${tokenResponse.status}`);
      }
      await saveDriveConnection({
        access_token_ciphertext: encrypt(tokenData.access_token),
        token_type: tokenData.token_type || "Bearer",
        scope: tokenData.scope || connection.scope || "",
        token_expires_at: new Date(Date.now() + Number(tokenData.expires_in || 3600) * 1000).toISOString(),
        connection_status: "connected",
        last_error: null,
      });
      return tokenData.access_token;
    } catch (error) {
      await saveDriveConnection({ connection_status: "error", last_error: error.message, last_checked_at: new Date().toISOString() }).catch(() => {});
      throw error;
    }
  };

  const driveToken = async ({ forceRefresh = false } = {}) => {
    const connection = await getDriveConnection().catch(() => null);
    const databaseToken = await refreshDriveAccessToken(connection, forceRefresh).catch((error) => {
      if (!process.env.GOOGLE_DRIVE_ACCESS_TOKEN) throw error;
      return "";
    });
    return databaseToken || process.env.GOOGLE_DRIVE_ACCESS_TOKEN || "";
  };

  const fetchAssetImage = async (asset) => {
    const sources = [];
    const token = await driveToken().catch(() => "");
    if (token && asset.drive_file_id) {
      sources.push({
        url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(asset.drive_file_id)}?alt=media`,
        headers: { authorization: `Bearer ${token}` },
      });
    }
    if (asset.delivery_url) sources.push({ url: asset.delivery_url, headers: {} });
    if (asset.file_url && asset.file_url !== asset.delivery_url) sources.push({ url: asset.file_url, headers: {} });
    let lastError = "Ảnh chưa có URL giao trực tiếp";
    for (const source of sources) {
      try {
        const imageResponse = await fetch(source.url, {
          headers: source.headers,
          redirect: "follow",
          signal: AbortSignal.timeout(20000),
        });
        const contentType = imageResponse.headers.get("content-type") || "";
        if (!imageResponse.ok || !contentType.toLowerCase().startsWith("image/")) {
          lastError = `HTTP ${imageResponse.status}, ${contentType || "không có content-type"}`;
          continue;
        }
        const buffer = Buffer.from(await imageResponse.arrayBuffer());
        if (!buffer.length) {
          lastError = "Tệp ảnh rỗng";
          continue;
        }
        return { buffer, contentType, sourceUrl: source.url, finalUrl: imageResponse.url };
      } catch (error) {
        lastError = error.message;
      }
    }
    throw new Error(`Không đọc được ${asset.file_name || "ảnh"}: ${lastError}`);
  };
  const publicAssetUrl = (request, asset) => {
    return `${requestOrigin(request)}/api/slide-manager/image/${encodeURIComponent(asset.id)}`;
  };

  const signOAuthState = () => {
    const payload = Buffer.from(JSON.stringify({ timestamp: Date.now(), nonce: crypto.randomBytes(12).toString("hex") })).toString("base64url");
    const signature = crypto.createHmac("sha256", encryptionKey).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  };

  const verifyOAuthState = (state) => {
    const [payload, signature] = String(state || "").split(".");
    if (!payload || !signature) return false;
    const expected = crypto.createHmac("sha256", encryptionKey).update(payload).digest();
    let actual;
    try { actual = Buffer.from(signature, "base64url"); } catch { return false; }
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      return Number(decoded.timestamp) > Date.now() - 15 * 60_000 && Number(decoded.timestamp) <= Date.now() + 60_000;
    } catch { return false; }
  };

  const router = express.Router();
  router.use(express.json({ limit: "18mb" }));

  router.get("/data", async (request, response) => {
    try {
      const [mappings, assets, pages, recipients, driveConnection] = await Promise.all([
        db("v8_slide_mapping?select=*&order=priority.asc,product_name.asc"),
        db("v8_drive_assets?select=*&deleted_from_drive_at=is.null&order=product_key.asc,sort_order.asc"),
        db("v8_pages?select=page_id,page_name,is_active&is_active=eq.true&order=page_name.asc"),
        db("v8_runtime_test_recipients?select=*&is_active=eq.true&order=label.asc"),
        getDriveConnection().catch(() => null),
      ]);
      response.json({
        ok: true,
        mappings: mappings || [],
        assets: assets || [],
        pages: pages || [],
        recipients: recipients || [],
        drive_connected: Boolean(driveConnection?.refresh_token_ciphertext || driveConnection?.access_token_ciphertext || process.env.GOOGLE_DRIVE_ACCESS_TOKEN),
        drive_connection: safeDriveConnection(driveConnection, request),
        meta_connected: Boolean(graphToken()),
      });
    } catch (error) {
      response.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post("/mapping", async (request, response) => {
    try {
      const body = request.body || {};
      if (!String(body.product_key || "").trim()) throw new Error("Cần nhập mã sản phẩm");
      if (!String(body.drive_folder_url || "").trim()) throw new Error("Cần nhập URL thư mục Google Drive");
      const folderId = idFromUrl(body.drive_folder_url);
      const row = {
        page_id: body.page_id || null,
        product_key: String(body.product_key).trim(),
        product_name: String(body.product_name || body.product_key).trim(),
        slide_title: body.slide_title || `Slide ${body.product_name || body.product_key}`,
        slide_url: body.drive_folder_url,
        drive_folder_url: body.drive_folder_url,
        drive_folder_id: folderId || null,
        priority: Number(body.priority || 100),
        is_active: body.is_active !== false,
        note: body.note || null,
        updated_at: new Date().toISOString(),
      };
      const result = body.id
        ? await db(`v8_slide_mapping?id=eq.${encodeURIComponent(body.id)}`, { method: "PATCH", body: JSON.stringify(row) })
        : await db("v8_slide_mapping", { method: "POST", body: JSON.stringify(row) });
      response.json({ ok: true, data: result?.[0] || null });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  router.delete("/mapping/:id", async (request, response) => {
    try {
      await db(`v8_slide_mapping?id=eq.${encodeURIComponent(request.params.id)}`, { method: "DELETE" });
      response.json({ ok: true });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/asset", async (request, response) => {
    try {
      const body = request.body || {};
      const fileId = idFromUrl(body.drive_file_id || body.file_url);
      if (!String(body.product_key || "").trim()) throw new Error("Cần nhập mã sản phẩm");
      if (!fileId) throw new Error("Cần nhập ID hoặc URL tệp Google Drive");
      const deliveryUrl = body.delivery_url || `https://drive.google.com/uc?export=view&id=${fileId}`;
      const row = {
        product_key: String(body.product_key).trim(),
        product_name: String(body.product_name || body.product_key).trim(),
        catalog_key: body.catalog_key || body.product_key,
        root_folder_url: body.root_folder_url || null,
        parent_folder_id: idFromUrl(body.parent_folder_id || body.parent_folder_url) || null,
        parent_folder_name: body.parent_folder_name || null,
        parent_folder_url: body.parent_folder_url || null,
        drive_file_id: fileId,
        file_name: body.file_name || fileId,
        mime_type: body.mime_type || "image/jpeg",
        file_url: body.file_url || `https://drive.google.com/file/d/${fileId}/view`,
        delivery_url: deliveryUrl,
        sort_order: Number(body.sort_order || 1000),
        is_image: true,
        is_active: body.is_active !== false,
        last_seen_at: new Date().toISOString(),
      };
      const result = body.id
        ? await db(`v8_drive_assets?id=eq.${encodeURIComponent(body.id)}`, { method: "PATCH", body: JSON.stringify(row) })
        : await db("v8_drive_assets", { method: "POST", body: JSON.stringify(row) });
      response.json({ ok: true, data: result?.[0] || null });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  router.delete("/asset/:id", async (request, response) => {
    try {
      const hardDelete = request.query.drive === "true";
      const rows = await db(`v8_drive_assets?id=eq.${encodeURIComponent(request.params.id)}&select=*`);
      const asset = rows?.[0];
      if (!asset) throw new Error("Không tìm thấy ảnh");
      if (hardDelete) {
        const token = await driveToken();
        if (!token) throw new Error("Chưa kết nối quyền ghi Google Drive");
        const driveResponse = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(asset.drive_file_id)}`,
          { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
        );
        if (!driveResponse.ok && driveResponse.status !== 404) {
          throw new Error(`GOOGLE_DRIVE_${driveResponse.status}: ${await driveResponse.text()}`);
        }
      }
      await db(`v8_drive_assets?id=eq.${encodeURIComponent(request.params.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          is_active: false,
          deleted_from_drive_at: hardDelete ? new Date().toISOString() : null,
        }),
      });
      response.json({ ok: true, deleted_from_drive: hardDelete });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/drive/folder", async (request, response) => {
    try {
      const token = await driveToken();
      if (!token) throw new Error("Chưa kết nối quyền ghi Google Drive");
      const body = request.body || {};
      if (!String(body.name || "").trim()) throw new Error("Cần nhập tên thư mục");
      const metadata = {
        name: String(body.name).trim(),
        mimeType: "application/vnd.google-apps.folder",
      };
      if (body.parent_id) metadata.parents = [idFromUrl(body.parent_id)];
      const driveResponse = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(metadata),
      });
      const data = await driveResponse.json();
      if (!driveResponse.ok) throw new Error(data.error?.message || `DRIVE_${driveResponse.status}`);
      response.json({ ok: true, data });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/check", async (request, response) => {
    try {
      const body = request.body || {};
      let contentType = "";
      let httpStatus = 0;
      let finalUrl = "";
      let valid = false;
      if (body.id) {
        const rows = await db(`v8_drive_assets?id=eq.${encodeURIComponent(body.id)}&select=*&limit=1`);
        const asset = rows?.[0];
        if (!asset) throw new Error("Không tìm thấy ảnh");
        const image = await fetchAssetImage(asset);
        contentType = image.contentType;
        httpStatus = 200;
        finalUrl = image.finalUrl;
        valid = true;
      } else {
        const url = String(body.url || "");
        if (!url) throw new Error("Ảnh chưa có URL giao trực tiếp");
        const imageResponse = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
        contentType = imageResponse.headers.get("content-type") || "";
        httpStatus = imageResponse.status;
        finalUrl = imageResponse.url;
        valid = imageResponse.ok && contentType.toLowerCase().startsWith("image/");
      }
      if (body.id) {
        await db(`v8_drive_assets?id=eq.${encodeURIComponent(body.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            delivery_status: valid ? "ready" : "invalid",
            delivery_http_status: httpStatus,
            delivery_content_type: contentType || null,
            delivery_error: valid ? null : "URL không trả về tệp ảnh trực tiếp",
            delivery_checked_at: new Date().toISOString(),
          }),
        });
      }
      response.json({
        ok: valid,
        http_status: httpStatus,
        content_type: contentType,
        final_url: finalUrl,
        error: valid ? null : "URL không trả về tệp ảnh trực tiếp",
      });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get("/image/:id", async (request, response) => {
    try {
      const rows = await db(`v8_drive_assets?id=eq.${encodeURIComponent(request.params.id)}&is_active=eq.true&deleted_from_drive_at=is.null&select=*&limit=1`);
      const asset = rows?.[0];
      if (!asset) throw new Error("Không tìm thấy ảnh đang hoạt động");
      const image = await fetchAssetImage(asset);
      response.set({
        "content-type": image.contentType,
        "content-length": String(image.buffer.length),
        "cache-control": "public, max-age=300, stale-while-revalidate=86400",
        "content-disposition": `inline; filename="${String(asset.file_name || "slide.jpg").replace(/["\\]/g, "_")}"`,
        "x-content-type-options": "nosniff",
      });
      response.send(image.buffer);
    } catch (error) {
      response.status(404).json({ ok: false, error: error.message });
    }
  });

  router.get("/google/status", async (request, response) => {
    try {
      response.json({ ok: true, data: safeDriveConnection(await getDriveConnection(), request) });
    } catch (error) {
      response.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post("/google/config", async (request, response) => {
    try {
      if (!serviceRoleKey) throw new Error("Máy chủ chưa có quyền lưu cấu hình an toàn vào Supabase");
      const body = request.body || {};
      const existing = await getDriveConnection();
      const clientId = String(body.client_id || "").trim();
      const clientSecret = String(body.client_secret || "").trim();
      if (!clientId) throw new Error("Cần nhập Client ID OAuth của Google");
      if (!clientSecret && !existing?.client_secret_ciphertext) throw new Error("Cần nhập Client Secret OAuth của Google");
      const clientChanged = Boolean(existing?.client_id && existing.client_id !== clientId);
      const row = {
        client_id: clientId,
        client_secret_hint: clientSecret ? `••••${clientSecret.slice(-4)}` : existing?.client_secret_hint || "",
        root_folder_id: idFromUrl(body.root_folder_id) || null,
        is_enabled: body.is_enabled !== false,
        connection_status: clientChanged ? "configured" : (existing?.connection_status === "connected" ? "connected" : "configured"),
        last_error: null,
      };
      if (clientSecret) row.client_secret_ciphertext = encrypt(clientSecret);
      if (clientChanged) {
        row.access_token_ciphertext = null;
        row.refresh_token_ciphertext = null;
        row.token_expires_at = null;
        row.account_email = null;
        row.account_name = null;
      }
      const saved = await saveDriveConnection(row);
      response.json({ ok: true, data: safeDriveConnection(saved, request) });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get("/google/connect", async (request, response) => {
    try {
      const connection = await getDriveConnection();
      if (!connection?.client_id || !connection?.client_secret_ciphertext) {
        throw new Error("Hãy lưu Client ID và Client Secret trước khi kết nối");
      }
      const parameters = new URLSearchParams({
        client_id: connection.client_id,
        redirect_uri: driveCallbackUrl(request),
        response_type: "code",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        scope: "https://www.googleapis.com/auth/drive",
        state: signOAuthState(),
      });
      response.json({ ok: true, authorization_url: `https://accounts.google.com/o/oauth2/v2/auth?${parameters}` });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get("/google/callback", async (request, response) => {
    const redirect = (status, message = "") => {
      const parameters = new URLSearchParams({ tab: "google", google: status });
      if (message) parameters.set("message", message.slice(0, 220));
      response.redirect(302, `/drive-slides?${parameters}`);
    };
    try {
      if (request.query.error) throw new Error(String(request.query.error_description || request.query.error));
      if (!verifyOAuthState(request.query.state)) throw new Error("Phiên kết nối Google đã hết hạn hoặc không hợp lệ");
      if (!request.query.code) throw new Error("Google không trả về mã ủy quyền");
      const connection = await getDriveConnection();
      if (!connection?.client_id || !connection?.client_secret_ciphertext) throw new Error("Thiếu cấu hình OAuth Google Drive");
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: String(request.query.code),
          client_id: connection.client_id,
          client_secret: decrypt(connection.client_secret_ciphertext),
          redirect_uri: driveCallbackUrl(request),
          grant_type: "authorization_code",
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const tokenData = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || !tokenData.access_token) {
        throw new Error(tokenData.error_description || tokenData.error || `GOOGLE_OAUTH_${tokenResponse.status}`);
      }
      const saved = {
        access_token_ciphertext: encrypt(tokenData.access_token),
        token_type: tokenData.token_type || "Bearer",
        scope: tokenData.scope || "https://www.googleapis.com/auth/drive",
        token_expires_at: new Date(Date.now() + Number(tokenData.expires_in || 3600) * 1000).toISOString(),
        connection_status: "connected",
        is_enabled: true,
        last_error: null,
      };
      if (tokenData.refresh_token) saved.refresh_token_ciphertext = encrypt(tokenData.refresh_token);
      await saveDriveConnection(saved);
      redirect("connected");
    } catch (error) {
      await saveDriveConnection({ connection_status: "error", last_error: error.message }).catch(() => {});
      redirect("error", error.message);
    }
  });

  router.post("/google/test", async (request, response) => {
    try {
      const token = await driveToken({ forceRefresh: true });
      if (!token) throw new Error("Chưa hoàn tất kết nối Google Drive");
      const driveResponse = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress),storageQuota(limit,usage)", {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      const driveData = await driveResponse.json().catch(() => ({}));
      if (!driveResponse.ok) throw new Error(driveData.error?.message || `GOOGLE_DRIVE_${driveResponse.status}`);
      const saved = await saveDriveConnection({
        connection_status: "connected",
        account_email: driveData.user?.emailAddress || null,
        account_name: driveData.user?.displayName || null,
        last_checked_at: new Date().toISOString(),
        last_error: null,
        metadata: { storage_quota: driveData.storageQuota || {} },
      });
      response.json({ ok: true, data: safeDriveConnection(saved, request) });
    } catch (error) {
      await saveDriveConnection({ connection_status: "error", last_checked_at: new Date().toISOString(), last_error: error.message }).catch(() => {});
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  router.delete("/google/connection", async (request, response) => {
    try {
      const connection = await getDriveConnection();
      const token = connection?.access_token_ciphertext ? decrypt(connection.access_token_ciphertext) : "";
      if (token) {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
      }
      const saved = await saveDriveConnection({
        access_token_ciphertext: null,
        refresh_token_ciphertext: null,
        token_expires_at: null,
        account_email: null,
        account_name: null,
        connection_status: "configured",
        last_checked_at: new Date().toISOString(),
        last_error: null,
      });
      response.json({ ok: true, data: safeDriveConnection(saved, request) });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/test-slide", async (request, response) => {
    try {
      const body = request.body || {};
      const recipientId = String(body.recipient_id || "").trim();
      if (!body.page_id || !recipientId) throw new Error("Cần chọn Trang và nhập PSID người nhận thử");
      if (!/^\d{5,32}$/.test(recipientId)) {
        throw new Error("PSID người nhận phải là dãy số của khách trên đúng Trang; không dùng tên tài khoản hoặc username Facebook");
      }
      if (!body.mapping_id) throw new Error("Cần chọn mapping sản phẩm");

      const mappingRows = await db(`v8_slide_mapping?id=eq.${encodeURIComponent(body.mapping_id)}&is_active=eq.true&select=*`);
      const mapping = mappingRows?.[0];
      if (!mapping) throw new Error("Mapping không tồn tại hoặc đã tắt");
      const assets = await db(
        `v8_drive_assets?product_key=eq.${encodeURIComponent(mapping.product_key)}&is_active=eq.true&deleted_from_drive_at=is.null&select=*&order=sort_order.asc`,
      );
      if (!(assets || []).length) throw new Error("Mapping chưa có ảnh đang hoạt động");

      const token = await pageToken(body.page_id);
      if (!token) throw new Error("Không tìm thấy Page Access Token của Trang đã chọn");
      const results = [];
      for (const [index, asset] of (assets || []).entries()) {
        const url = publicAssetUrl(request, asset);
        try {
          const checkedImage = await fetchAssetImage(asset);
          const metaResponse = await fetch(
            `https://graph.facebook.com/v23.0/${encodeURIComponent(body.page_id)}/messages?access_token=${encodeURIComponent(token)}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                recipient: { id: recipientId },
                messaging_type: "RESPONSE",
                message: { attachment: { type: "image", payload: { url, is_reusable: true } } },
              }),
            },
          );
          const metaData = await metaResponse.json();
          if (!metaResponse.ok) throw new Error(metaData.error?.message || `META_${metaResponse.status}`);
          results.push({ asset_id: asset.id, file_name: asset.file_name, position: index + 1, url, source_url: asset.delivery_url || asset.file_url, content_type: checkedImage.contentType, ok: true, message_id: metaData.message_id, recipient_id: metaData.recipient_id });
        } catch (error) {
          results.push({ asset_id: asset.id, file_name: asset.file_name, position: index + 1, url, source_url: asset.delivery_url || asset.file_url, ok: false, error: error.message });
        }
      }

      await db("v8_slide_logs", {
        method: "POST",
        body: JSON.stringify(results.map((result) => ({
          page_id: body.page_id,
          sender_id: recipientId,
          product_key: mapping.product_key,
          slide_url: result.source_url || result.url,
          send_status: result.ok ? "sent" : "failed",
          send_error: result.error || null,
          sent_at: result.ok ? new Date().toISOString() : null,
          decision_status: "runtime_test",
          safety_status: "manual_test",
          reason: {
            message_id: result.message_id || null,
            mapping_id: mapping.id,
            channel: "meta_send_api",
            delivery_url: result.url,
            visibility_targets: ["messenger", "meta_business_suite", "pancake"],
          },
        }))),
      });
      const successCount = results.filter((result) => result.ok).length;
      response.json({
        ok: true,
        all_sent: successCount === results.length,
        mapping: { id: mapping.id, product_key: mapping.product_key, product_name: mapping.product_name },
        total: results.length,
        success_count: successCount,
        failure_count: results.length - successCount,
        results,
      });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  app.use("/api/slide-manager", router);
  app.get("/drive-slides", (_request, response) => response.type("html").send(page()));
}


function page() {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Mapping, Google Drive và chạy thử slide</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#172033;font:14px Arial,sans-serif}.wrap{max-width:1500px;margin:auto;padding:22px}.top,.panel{background:#fff;border:1px solid #d5deea;border-radius:12px;padding:16px;margin-bottom:14px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px}.top h1{margin:0 0 8px}.tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}.tabs button.active,.primary{background:#155eef;color:#fff;border-color:#155eef}button,input,select,textarea{border:1px solid #bdc9da;border-radius:7px;padding:8px;background:#fff;font:inherit}button{cursor:pointer}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.wide{grid-column:span 2}label{display:block;font-weight:700;font-size:12px;margin:4px 0}input,select{width:100%}table{width:100%;border-collapse:collapse}th,td{border:1px solid #cbd5e1;padding:8px;text-align:left;vertical-align:middle}th{background:#eaf0f8}.hide{display:none!important}.ok{color:#067647}.bad{color:#b42318}.muted{color:#667085}.actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.thumb{width:92px;height:70px;object-fit:cover;border-radius:6px;border:1px solid #d5deea;background:#f8fafc}.preview-card{display:flex;flex-direction:column;gap:5px;align-items:center;font-size:12px}.status{padding:10px 12px;margin-bottom:14px;border:1px solid #93c5fd;background:#eff6ff;border-radius:8px}.status.bad{border-color:#fda29b;background:#fef3f2;color:#b42318}.empty{text-align:center;color:#667085;padding:18px}.table-wrap{overflow:auto}.connection-card{border:1px solid #d0d5dd;border-radius:10px;padding:14px;background:#f8fafc;margin-bottom:14px}.connection-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.badge{display:inline-flex;border-radius:999px;padding:5px 9px;background:#fff1c2;color:#854a0e;font-weight:700}.badge.connected{background:#d1fadf;color:#05603a}.notice{padding:11px 12px;border:1px solid #84caff;background:#eff8ff;border-radius:8px;margin:10px 0}.result-box{margin-top:14px;border:1px solid #d0d5dd;border-radius:10px;overflow:hidden}.result-summary{padding:12px;background:#f8fafc;font-weight:700}.result-summary.success{background:#ecfdf3;color:#05603a}.result-summary.failure{background:#fef3f2;color:#912018}.result-row{display:grid;grid-template-columns:54px minmax(140px,1fr) minmax(160px,2fr);gap:10px;align-items:center;padding:10px 12px;border-top:1px solid #eaecf0}.result-row .number{font-weight:700;color:#475467}.secret-note{font-size:12px;color:#667085}.copy-row{display:flex;gap:7px}.copy-row input{flex:1}.oauth-actions{margin-top:14px}.loading{opacity:.6;pointer-events:none}@media(max-width:800px){.wrap{padding:10px}.top{align-items:flex-start;flex-direction:column}.grid{grid-template-columns:1fr}.wide{grid-column:auto}.result-row{grid-template-columns:40px 1fr}.result-row div:last-child{grid-column:2}.tabs button{flex:1 1 46%}th,td{white-space:nowrap}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div><h1>Mapping, Google Drive và chạy thử slide</h1><div class="muted">Kiểm tra đúng luồng hiển thị trên Messenger, Meta Business Suite và Pancake.</div></div>
      <a href="/dashboard">Về bảng điều khiển</a>
    </div>
    <div id="status" class="status">Đang tải dữ liệu…</div>
    <div class="tabs">
      <button type="button" class="active" data-tab="mapping">Mapping</button>
      <button type="button" data-tab="assets">Ảnh và thư mục Drive</button>
      <button type="button" data-tab="test">Chạy thử slide</button>
      <button type="button" data-tab="google">Kết nối Google Drive</button>
    </div>

    <section id="mapping" class="panel tab-panel">
      <h2>Mapping sản phẩm → thư mục ảnh</h2>
      <form id="mapping-form" class="grid">
        <input type="hidden" name="id">
        <div><label>Mã sản phẩm</label><input name="product_key" required></div>
        <div><label>Tên sản phẩm</label><input name="product_name" required></div>
        <div class="wide"><label>URL thư mục Google Drive</label><input name="drive_folder_url" required></div>
        <div><label>Trang Facebook (trống = tất cả)</label><select name="page_id" id="mapping-page"></select></div>
        <div><label>Ưu tiên</label><input name="priority" type="number" value="100"></div>
        <div class="wide"><label>Ghi chú</label><input name="note"></div>
        <div class="actions"><button class="primary">Lưu mapping</button><button id="mapping-new" type="button">Thêm mới</button></div>
      </form>
      <hr>
      <div class="table-wrap"><table><thead><tr><th>Sản phẩm</th><th>Thư mục</th><th>Trang</th><th>Ảnh</th><th>Thao tác</th></tr></thead><tbody id="mapping-rows"></tbody></table></div>
    </section>

    <section id="assets" class="panel tab-panel hide">
      <h2>CRUD ảnh và thư mục Google Drive</h2>
      <div id="connection" class="connection-card"></div>
      <form id="asset-form" class="grid">
        <input type="hidden" name="id">
        <div><label>Mã sản phẩm</label><input name="product_key" required></div>
        <div><label>Tên sản phẩm</label><input name="product_name"></div>
        <div><label>Tên tệp</label><input name="file_name" required></div>
        <div><label>ID hoặc URL tệp Drive</label><input name="drive_file_id" required></div>
        <div class="wide"><label>URL ảnh trực tiếp (có thể bỏ trống)</label><input name="delivery_url"></div>
        <div><label>Tên thư mục</label><input name="parent_folder_name"></div>
        <div><label>ID/URL thư mục</label><input name="parent_folder_id"></div>
        <div><label>Thứ tự</label><input name="sort_order" type="number" value="1000"></div>
        <div class="actions"><button class="primary">Lưu ảnh</button><button id="asset-new" type="button">Thêm mới</button></div>
      </form>
      <div class="actions" style="margin:12px 0"><input id="new-folder" style="width:auto" placeholder="Tên thư mục mới"><input id="parent-folder" style="width:auto" placeholder="ID thư mục cha (không bắt buộc)"><button id="create-folder" type="button">+ Tạo thư mục Drive</button></div>
      <div class="table-wrap"><table><thead><tr><th>Ảnh</th><th>Sản phẩm / thư mục</th><th>Nguồn Drive</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody id="asset-rows"></tbody></table></div>
    </section>

    <section id="test" class="panel tab-panel hide">
      <h2>Chạy thẳng slide qua Meta Send API</h2>
      <div class="grid">
        <div><label>Trang Facebook</label><select id="test-page"></select></div>
        <div><label>Người nhận thử (PSID dạng số)</label><input id="recipient" list="recipient-list" inputmode="numeric" pattern="[0-9]{5,32}" placeholder="Ví dụ: 28308705945387770"><datalist id="recipient-list"></datalist></div>
        <div><label>Mapping sản phẩm</label><select id="test-mapping"></select></div>
        <div style="align-self:end"><button id="run-test" type="button" class="primary">▶ Gửi thử toàn bộ slide</button></div>
      </div>
      <p class="notice"><b>Lưu ý:</b> PSID là dãy số của khách trên đúng Trang Facebook. Tên người dùng, username hoặc đường dẫn hồ sơ Facebook không gửi được qua Meta Send API.</p>
      <p class="muted">Ảnh được đọc qua máy chủ AIGUKA, kiểm tra định dạng image/*, gửi từng ảnh qua Meta và ghi lại message_id.</p>
      <div id="preview" class="actions"></div>
      <div id="result" class="result-box"><div class="result-summary">Chưa chạy thử.</div></div>
    </section>

    <section id="google" class="panel tab-panel hide">
      <h2>Kết nối Google Drive trực tiếp</h2>
      <div class="notice">Không cần tạo Variables Google Drive trên Railway. Client Secret và token OAuth được mã hóa AES-256-GCM ở máy chủ trước khi lưu vào Supabase; trình duyệt không thể đọc lại khóa gốc.</div>
      <div id="google-state" class="connection-card"></div>
      <form id="google-form" class="grid">
        <div class="wide"><label>Client ID OAuth 2.0</label><input id="google-client-id" autocomplete="off" required placeholder="...apps.googleusercontent.com"></div>
        <div class="wide"><label>Client Secret mới</label><input id="google-client-secret" type="password" autocomplete="new-password" placeholder="Để trống nếu không đổi"></div>
        <div class="wide"><label>ID hoặc URL thư mục gốc (không bắt buộc)</label><input id="google-root-folder" placeholder="ID thư mục Google Drive"></div>
        <div><label>Trạng thái</label><label style="display:flex;align-items:center;gap:8px;font-weight:400"><input id="google-enabled" type="checkbox" style="width:auto" checked> Cho phép sử dụng kết nối</label></div>
        <div class="wide"><label>URI chuyển hướng cần khai báo trong Google Cloud</label><div class="copy-row"><input id="google-callback" readonly><button id="copy-callback" type="button">Sao chép</button></div></div>
        <div class="actions" style="align-self:end"><button class="primary">Lưu cấu hình</button></div>
      </form>
      <div class="actions oauth-actions"><button id="google-connect" type="button" class="primary">Kết nối tài khoản Google</button><button id="google-test" type="button">Kiểm tra kết nối</button><button id="google-disconnect" type="button">Ngắt kết nối</button></div>
      <p class="secret-note">Trước khi bấm Kết nối, hãy thêm chính xác URI chuyển hướng ở trên vào OAuth Client loại “Web application” trong Google Cloud.</p>
    </section>
  </div>
  <script>
    let data = { mappings: [], assets: [], pages: [], recipients: [], drive_connection: {} };
    const byId = (id) => document.getElementById(id);
    const escapeHtml = ${esc.toString()};
    const previewUrl = (asset) => '/api/slide-manager/image/' + encodeURIComponent(asset.id);

    function setStatus(message, ok = true) {
      const element = byId('status');
      element.textContent = message;
      element.className = 'status' + (ok ? '' : ' bad');
    }

    async function api(path, options = {}) {
      const response = await fetch('/api/slide-manager' + path, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      });
      const text = await response.text();
      let json;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text || 'Phản hồi không hợp lệ' }; }
      if (!response.ok || json.ok === false) throw new Error(json.error || 'Có lỗi xảy ra');
      return json;
    }

    function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
    function resetForm(id) { const form = byId(id); form.reset(); if (form.elements.id) form.elements.id.value = ''; }
    function fillForm(form, row) {
      if (!row) return;
      Object.entries(row).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value == null ? '' : value; });
    }

    function openTab(id) {
      document.querySelectorAll('[data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === id));
      document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('hide', panel.id !== id));
      if (id === 'test') renderPreview();
    }

    function renderMappings() {
      const counts = new Map();
      data.assets.filter((asset) => asset.is_active).forEach((asset) => counts.set(asset.product_key, (counts.get(asset.product_key) || 0) + 1));
      byId('mapping-rows').innerHTML = data.mappings.length ? data.mappings.map((row) => (
        '<tr><td><b>' + escapeHtml(row.product_name) + '</b><br><small>' + escapeHtml(row.product_key) + '</small></td>'
        + '<td><a target="_blank" rel="noopener" href="' + escapeHtml(row.drive_folder_url || '#') + '">' + escapeHtml(row.drive_folder_id || 'Chưa có') + '</a></td>'
        + '<td>' + escapeHtml(row.page_id || 'Tất cả') + '</td><td>' + (counts.get(row.product_key) || 0) + '</td>'
        + '<td><div class="actions"><button type="button" data-action="edit-mapping" data-id="' + escapeHtml(row.id) + '">Sửa</button>'
        + '<button type="button" data-action="delete-mapping" data-id="' + escapeHtml(row.id) + '">Xóa</button></div></td></tr>'
      )).join('') : '<tr><td colspan="5" class="empty">Chưa có mapping.</td></tr>';
    }

    function renderAssets() {
      byId('asset-rows').innerHTML = data.assets.length ? data.assets.map((row) => (
        '<tr><td><img class="thumb" loading="lazy" alt="' + escapeHtml(row.file_name) + '" src="' + escapeHtml(previewUrl(row)) + '"></td>'
        + '<td><b>' + escapeHtml(row.file_name) + '</b><br>' + escapeHtml(row.product_key) + ' · ' + escapeHtml(row.parent_folder_name || '') + '</td>'
        + '<td><small>ID: ' + escapeHtml(row.drive_file_id || '-') + '</small></td><td>' + escapeHtml(row.delivery_status || 'Chưa kiểm tra') + '</td>'
        + '<td><div class="actions"><button type="button" data-action="check-asset" data-id="' + escapeHtml(row.id) + '">Kiểm tra</button>'
        + '<button type="button" data-action="edit-asset" data-id="' + escapeHtml(row.id) + '">Sửa</button>'
        + '<button type="button" data-action="remove-asset" data-id="' + escapeHtml(row.id) + '">Gỡ danh mục</button>'
        + '<button type="button" data-action="delete-drive" data-id="' + escapeHtml(row.id) + '">Xóa Drive</button></div></td></tr>'
      )).join('') : '<tr><td colspan="5" class="empty">Chưa có ảnh.</td></tr>';
    }

    function renderSelectors() {
      const allPages = '<option value="">Tất cả Trang</option>' + data.pages.map((page) => '<option value="' + escapeHtml(page.page_id) + '">' + escapeHtml(page.page_name) + '</option>').join('');
      byId('mapping-page').innerHTML = allPages;
      byId('test-page').innerHTML = data.pages.map((page) => '<option value="' + escapeHtml(page.page_id) + '">' + escapeHtml(page.page_name) + '</option>').join('');
      byId('test-mapping').innerHTML = data.mappings.map((mapping) => '<option value="' + escapeHtml(mapping.id) + '">' + escapeHtml(mapping.product_name) + '</option>').join('');
      byId('recipient-list').innerHTML = data.recipients.map((recipient) => '<option value="' + escapeHtml(recipient.sender_id) + '">' + escapeHtml(recipient.label || recipient.sender_id) + '</option>').join('');
    }

    function renderPreview() {
      const mapping = data.mappings.find((row) => row.id === byId('test-mapping').value) || data.mappings[0];
      const assets = data.assets.filter((asset) => mapping && asset.product_key === mapping.product_key && asset.is_active).sort((left, right) => Number(left.sort_order) - Number(right.sort_order));
      byId('preview').innerHTML = assets.length ? assets.map((asset, index) => (
        '<div class="preview-card"><img class="thumb" alt="' + escapeHtml(asset.file_name) + '" src="' + escapeHtml(previewUrl(asset)) + '"><span>' + (index + 1) + '. ' + escapeHtml(asset.file_name) + '</span></div>'
      )).join('') : '<span class="muted">Mapping này chưa có ảnh hoạt động.</span>';
    }

    function renderConnection() {
      const connection = data.drive_connection || {};
      const connected = Boolean(connection.connected || data.drive_connected);
      byId('connection').innerHTML = '<div class="connection-head"><div><b>Google Drive</b><div class="muted">' + escapeHtml(connection.account_email || (connected ? 'Đã có quyền truy cập' : 'Chưa kết nối quyền ghi')) + '</div></div><span class="badge ' + (connected ? 'connected' : '') + '">' + (connected ? 'Đã kết nối' : 'Chưa kết nối') + '</span></div>';
      byId('google-state').innerHTML = '<div class="connection-head"><div><b>' + (connected ? 'Kết nối đang hoạt động' : (connection.configured ? 'Đã lưu cấu hình OAuth' : 'Chưa cấu hình OAuth')) + '</b><div class="muted">' + escapeHtml(connection.account_name || '') + (connection.account_email ? ' · ' + escapeHtml(connection.account_email) : '') + '</div></div><span class="badge ' + (connected ? 'connected' : '') + '">' + escapeHtml(connection.status || 'not_configured') + '</span></div>' + (connection.last_error ? '<p class="bad">' + escapeHtml(connection.last_error) + '</p>' : '');
      byId('google-client-id').value = connection.client_id || '';
      byId('google-client-secret').value = '';
      byId('google-client-secret').placeholder = connection.client_secret_hint ? 'Đã lưu ' + connection.client_secret_hint + ' · để trống nếu không đổi' : 'Nhập Client Secret';
      byId('google-root-folder').value = connection.root_folder_id || '';
      byId('google-enabled').checked = connection.enabled !== false;
      byId('google-callback').value = connection.callback_url || '';
    }

    function renderTestResult(result) {
      const allSent = result.all_sent === true;
      const rows = (result.results || []).map((item, index) => (
        '<div class="result-row"><div class="number">#' + (index + 1) + '</div><div><b>' + escapeHtml(item.file_name || 'Ảnh ' + (index + 1)) + '</b><br><span class="' + (item.ok ? 'ok' : 'bad') + '">' + (item.ok ? 'Đã gửi' : 'Gửi thất bại') + '</span></div><div>' + (item.ok ? 'Meta message_id: <b>' + escapeHtml(item.message_id || '-') + '</b>' : escapeHtml(item.error || 'Không xác định được lỗi')) + '</div></div>'
      )).join('');
      byId('result').innerHTML = '<div class="result-summary ' + (allSent ? 'success' : 'failure') + '">' + (allSent ? 'Đã gửi đủ ' + result.success_count + '/' + result.total + ' ảnh.' : 'Đã gửi ' + result.success_count + '/' + result.total + ' ảnh; ' + result.failure_count + ' ảnh thất bại.') + '</div>' + rows;
    }

    function render() { renderSelectors(); renderMappings(); renderAssets(); renderPreview(); renderConnection(); }

    async function load() {
      setStatus('Đang tải mapping và ảnh…');
      data = await api('/data');
      render();
      setStatus('Đã tải ' + data.mappings.length + ' mapping và ' + data.assets.length + ' ảnh.');
    }

    async function removeMapping(id) {
      if (!confirm('Xóa mapping này?')) return;
      await api('/mapping/' + encodeURIComponent(id), { method: 'DELETE' });
      await load();
    }

    async function removeAsset(id, fromDrive) {
      const message = fromDrive ? 'Xóa thật tệp trên Google Drive? Thao tác này không hoàn tác.' : 'Gỡ ảnh khỏi danh mục AIGUKA?';
      if (!confirm(message)) return;
      await api('/asset/' + encodeURIComponent(id) + '?drive=' + fromDrive, { method: 'DELETE' });
      await load();
    }

    async function checkAsset(id) {
      const asset = data.assets.find((row) => row.id === id);
      if (!asset) throw new Error('Không tìm thấy ảnh');
      const url = new URL(previewUrl(asset), location.origin).href;
      const result = await api('/check', { method: 'POST', body: JSON.stringify({ id, url }) });
      setStatus('Ảnh ' + asset.file_name + ' hợp lệ: ' + result.content_type);
      await load();
    }

    document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => openTab(button.dataset.tab)));
    byId('mapping-new').addEventListener('click', () => resetForm('mapping-form'));
    byId('asset-new').addEventListener('click', () => resetForm('asset-form'));
    byId('test-mapping').addEventListener('change', renderPreview);

    byId('mapping-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try { setStatus('Đang lưu mapping…'); await api('/mapping', { method: 'POST', body: JSON.stringify(formObject(event.currentTarget)) }); resetForm('mapping-form'); await load(); }
      catch (error) { setStatus(error.message, false); }
    });

    byId('asset-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try { setStatus('Đang lưu ảnh…'); await api('/asset', { method: 'POST', body: JSON.stringify(formObject(event.currentTarget)) }); resetForm('asset-form'); await load(); }
      catch (error) { setStatus(error.message, false); }
    });

    byId('create-folder').addEventListener('click', async () => {
      try {
        setStatus('Đang tạo thư mục Google Drive…');
        const result = await api('/drive/folder', { method: 'POST', body: JSON.stringify({ name: byId('new-folder').value, parent_id: byId('parent-folder').value }) });
        byId('new-folder').value = '';
        setStatus('Đã tạo thư mục ' + result.data.name + ' · ' + result.data.id);
      } catch (error) { setStatus(error.message, false); }
    });

    document.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const id = button.dataset.id;
      try {
        if (button.dataset.action === 'edit-mapping') { fillForm(byId('mapping-form'), data.mappings.find((row) => row.id === id)); openTab('mapping'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
        else if (button.dataset.action === 'delete-mapping') await removeMapping(id);
        else if (button.dataset.action === 'edit-asset') { fillForm(byId('asset-form'), data.assets.find((row) => row.id === id)); openTab('assets'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
        else if (button.dataset.action === 'check-asset') await checkAsset(id);
        else if (button.dataset.action === 'remove-asset') await removeAsset(id, false);
        else if (button.dataset.action === 'delete-drive') await removeAsset(id, true);
      } catch (error) { setStatus(error.message, false); }
    });

    byId('run-test').addEventListener('click', async () => {
      const mappingId = byId('test-mapping').value;
      const recipient = byId('recipient').value.trim();
      if (!mappingId) { setStatus('Chưa có mapping để chạy thử', false); return; }
      if (!/^[0-9]{5,32}$/.test(recipient)) { setStatus('PSID phải là dãy số; không dùng username Facebook', false); return; }
      byId('result').innerHTML = '<div class="result-summary">Đang kiểm tra ảnh và gửi qua Meta…</div>';
      try {
        const result = await api('/test-slide', { method: 'POST', body: JSON.stringify({ page_id: byId('test-page').value, recipient_id: recipient, mapping_id: mappingId }) });
        renderTestResult(result);
        setStatus(result.all_sent ? 'Đã gửi thử toàn bộ slide.' : 'Có ảnh gửi thất bại; xem kết quả chi tiết.', result.all_sent);
      } catch (error) {
        byId('result').innerHTML = '<div class="result-summary failure">' + escapeHtml(error.message) + '</div>';
        setStatus(error.message, false);
      }
    });

    byId('google-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        setStatus('Đang mã hóa và lưu cấu hình Google Drive…');
        const result = await api('/google/config', { method: 'POST', body: JSON.stringify({ client_id: byId('google-client-id').value.trim(), client_secret: byId('google-client-secret').value.trim(), root_folder_id: byId('google-root-folder').value.trim(), is_enabled: byId('google-enabled').checked }) });
        data.drive_connection = result.data; renderConnection(); setStatus('Đã lưu cấu hình Google Drive vào Supabase.');
      } catch (error) { setStatus(error.message, false); }
    });

    byId('google-connect').addEventListener('click', async () => {
      try { setStatus('Đang mở trang cấp quyền Google…'); const result = await api('/google/connect'); location.href = result.authorization_url; }
      catch (error) { setStatus(error.message, false); }
    });

    byId('google-test').addEventListener('click', async () => {
      try { setStatus('Đang kiểm tra quyền đọc/ghi Google Drive…'); const result = await api('/google/test', { method: 'POST' }); data.drive_connection = result.data; renderConnection(); setStatus('Kết nối Google Drive hoạt động: ' + (result.data.account_email || 'đã xác thực')); }
      catch (error) { setStatus(error.message, false); }
    });

    byId('google-disconnect').addEventListener('click', async () => {
      if (!confirm('Ngắt quyền Google Drive khỏi AIGUKA? Client ID vẫn được giữ để có thể kết nối lại.')) return;
      try { const result = await api('/google/connection', { method: 'DELETE' }); data.drive_connection = result.data; data.drive_connected = false; renderConnection(); setStatus('Đã ngắt kết nối Google Drive.'); }
      catch (error) { setStatus(error.message, false); }
    });

    byId('copy-callback').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(byId('google-callback').value); setStatus('Đã sao chép URI chuyển hướng.'); }
      catch { byId('google-callback').select(); document.execCommand('copy'); setStatus('Đã sao chép URI chuyển hướng.'); }
    });

    const query = new URLSearchParams(location.search);
    load().then(() => {
      const requestedTab = query.get('tab');
      if (requestedTab && byId(requestedTab)) openTab(requestedTab);
      if (query.get('google') === 'connected') setStatus('Đã cấp quyền Google Drive thành công. Hãy bấm “Kiểm tra kết nối”.');
      if (query.get('google') === 'error') setStatus(query.get('message') || 'Không kết nối được Google Drive.', false);
    }).catch((error) => setStatus(error.message, false));
  </script>
</body>
</html>`;
}
