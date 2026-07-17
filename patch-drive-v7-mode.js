import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "drive-slide-manager.js";
let source = fs.readFileSync(file, "utf8");

if (source.includes("AIGUKA_DRIVE_V7_MODE")) {
  console.log("[AIGUKA] Drive V7 connection mode already patched");
} else {
  const replaceRequired = (pattern, replacement, label) => {
    if (!pattern.test(source)) throw new Error(`DRIVE_V7_MODE_ANCHOR_NOT_FOUND:${label}`);
    source = source.replace(pattern, replacement);
  };

  if (!source.includes("AIGUKA_DRIVE_LOGIN_ONLY")) {
    throw new Error("DRIVE_V7_MODE_REQUIRES_LOGIN_ONLY_PATCH");
  }
  source = source.replace("// AIGUKA_DRIVE_LOGIN_ONLY", "// AIGUKA_DRIVE_LOGIN_ONLY\n// AIGUKA_DRIVE_V7_MODE");

  replaceRequired(
    /  const safeDriveConnection = \(row, _request\) => \(\{[\s\S]*?\n  \}\);/,
    `  const isV7DriveConnection = (row) => (
    String(row?.client_id || "") === "aiguka_v7_api_key"
    && Boolean(row?.client_secret_ciphertext)
  );

  const getV7DriveApiKey = (row) => (
    isV7DriveConnection(row) ? decrypt(row.client_secret_ciphertext) : ""
  );

  const verifyV7DriveConnection = async (connection) => {
    const apiKey = getV7DriveApiKey(connection);
    const rootFolderId = String(connection?.root_folder_id || "").trim();
    if (!apiKey || !rootFolderId) throw new Error("Thiếu kết nối Google Drive ver7 hoặc thư mục gốc");
    const parameters = new URLSearchParams({
      key: apiKey,
      fields: "id,name,mimeType,webViewLink,owners(displayName,emailAddress)",
      supportsAllDrives: "true",
    });
    const driveResponse = await fetch(
      \`https://www.googleapis.com/drive/v3/files/\${encodeURIComponent(rootFolderId)}?\${parameters}\`,
      { signal: AbortSignal.timeout(20_000) },
    );
    const driveData = await driveResponse.json().catch(() => ({}));
    if (!driveResponse.ok || !driveData.id) {
      throw new Error(driveData.error?.message || \`GOOGLE_DRIVE_\${driveResponse.status}\`);
    }
    if (driveData.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error("ID Drive hiện tại không phải thư mục");
    }
    return driveData;
  };

  const safeDriveConnection = (row, _request) => {
    const enabled = row?.is_enabled !== false;
    const oauthConnected = Boolean(row?.refresh_token_ciphertext || row?.access_token_ciphertext);
    const v7Connected = isV7DriveConnection(row) && row?.connection_status === "connected";
    return {
      configured: Boolean(row?.client_id && row?.client_secret_ciphertext),
      connected: Boolean(enabled && (oauthConnected || v7Connected)),
      enabled,
      mode: isV7DriveConnection(row) ? "v7_api_key" : "oauth",
      status: row?.connection_status || "not_configured",
      root_folder_id: row?.root_folder_id || "",
      account_email: row?.account_email || "",
      account_name: row?.account_name || "",
      scope: row?.scope || "",
      last_checked_at: row?.last_checked_at || null,
      last_error: row?.last_error || null,
    };
  };`,
    "safe_connection",
  );

  source = source.replace(
    "drive_connected: Boolean(driveConnection?.refresh_token_ciphertext || driveConnection?.access_token_ciphertext || process.env.GOOGLE_DRIVE_ACCESS_TOKEN),",
    "drive_connected: Boolean(driveConnection?.is_enabled !== false && (driveConnection?.refresh_token_ciphertext || driveConnection?.access_token_ciphertext || process.env.GOOGLE_DRIVE_ACCESS_TOKEN || (isV7DriveConnection(driveConnection) && driveConnection?.connection_status === 'connected'))),",
  );

  replaceRequired(
    /  router\.get\("\/google\/connect", async \(request, response\) => \{[\s\S]*?\n  \}\);\n\n  router\.get\("\/google\/callback"/,
    `  router.post("/google/root", async (request, response) => {
    try {
      const connection = await getDriveConnection();
      if (!isV7DriveConnection(connection)) throw new Error("Kết nối Drive ver7 chưa được khôi phục");
      const rootFolderId = idFromUrl(request.body?.root_folder_id || request.body?.root_folder_url);
      if (!rootFolderId) throw new Error("Cần dán link hoặc ID thư mục gốc Google Drive");
      const candidate = { ...connection, root_folder_id: rootFolderId, is_enabled: true };
      const driveData = await verifyV7DriveConnection(candidate);
      const saved = await saveDriveConnection({
        root_folder_id: rootFolderId,
        is_enabled: true,
        connection_status: "connected",
        account_name: driveData.owners?.[0]?.displayName || connection.account_name || driveData.name || "Google Drive",
        account_email: driveData.owners?.[0]?.emailAddress || connection.account_email || null,
        last_checked_at: new Date().toISOString(),
        last_error: null,
        metadata: { ...(connection.metadata || {}), root_folder_name: driveData.name, connection_mode: "v7_api_key" },
      });
      response.json({ ok: true, connected: true, data: safeDriveConnection(saved, request) });
    } catch (error) {
      await saveDriveConnection({ connection_status: "error", last_checked_at: new Date().toISOString(), last_error: error.message }).catch(() => {});
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get("/google/connect", async (request, response) => {
    try {
      const connection = await getDriveConnection();
      if (isV7DriveConnection(connection)) {
        const driveData = await verifyV7DriveConnection(connection);
        const saved = await saveDriveConnection({
          is_enabled: true,
          connection_status: "connected",
          account_name: driveData.owners?.[0]?.displayName || connection.account_name || driveData.name || "Google Drive",
          account_email: driveData.owners?.[0]?.emailAddress || connection.account_email || null,
          last_checked_at: new Date().toISOString(),
          last_error: null,
          metadata: { ...(connection.metadata || {}), root_folder_name: driveData.name, connection_mode: "v7_api_key" },
        });
        response.json({ ok: true, connected: true, data: safeDriveConnection(saved, request) });
        return;
      }
      if (!connection?.client_id || !connection?.client_secret_ciphertext) {
        throw new Error("Kết nối Google Drive của hệ thống chưa sẵn sàng");
      }
      const switchingAccount = String(request.query.switch || "") === "1";
      const parameters = new URLSearchParams({
        client_id: connection.client_id,
        redirect_uri: driveCallbackUrl(request),
        response_type: "code",
        access_type: "offline",
        prompt: switchingAccount ? "consent select_account" : "consent",
        include_granted_scopes: "true",
        scope: "https://www.googleapis.com/auth/drive",
        state: signOAuthState(),
      });
      response.json({ ok: true, authorization_url: \`https://accounts.google.com/o/oauth2/v2/auth?\${parameters}\` });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get("/google/callback"`,
    "connect_and_root_routes",
  );

  replaceRequired(
    /  router\.post\("\/google\/test", async \(request, response\) => \{[\s\S]*?\n  \}\);\n\n  router\.delete\("\/google\/connection"/,
    `  router.post("/google/test", async (request, response) => {
    try {
      const connection = await getDriveConnection();
      if (isV7DriveConnection(connection)) {
        const driveData = await verifyV7DriveConnection(connection);
        const saved = await saveDriveConnection({
          is_enabled: true,
          connection_status: "connected",
          account_name: driveData.owners?.[0]?.displayName || connection.account_name || driveData.name || "Google Drive",
          account_email: driveData.owners?.[0]?.emailAddress || connection.account_email || null,
          last_checked_at: new Date().toISOString(),
          last_error: null,
          metadata: { ...(connection.metadata || {}), root_folder_name: driveData.name, connection_mode: "v7_api_key" },
        });
        response.json({ ok: true, data: safeDriveConnection(saved, request), root_folder_name: driveData.name });
        return;
      }
      const token = await driveToken({ forceRefresh: true });
      if (!token) throw new Error("Chưa hoàn tất kết nối Google Drive");
      const driveResponse = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress),storageQuota(limit,usage)", {
        headers: { authorization: \`Bearer \${token}\` },
        signal: AbortSignal.timeout(20_000),
      });
      const driveData = await driveResponse.json().catch(() => ({}));
      if (!driveResponse.ok) throw new Error(driveData.error?.message || \`GOOGLE_DRIVE_\${driveResponse.status}\`);
      const saved = await saveDriveConnection({
        connection_status: "connected",
        is_enabled: true,
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

  router.delete("/google/connection"`,
    "test_route",
  );

  replaceRequired(
    /  router\.delete\("\/google\/connection", async \(request, response\) => \{[\s\S]*?\n  \}\);\n\n  router\.post\("\/test-slide"/,
    `  router.delete("/google/connection", async (request, response) => {
    try {
      const connection = await getDriveConnection();
      if (isV7DriveConnection(connection)) {
        const saved = await saveDriveConnection({
          is_enabled: false,
          connection_status: "disconnected",
          last_checked_at: new Date().toISOString(),
          last_error: null,
        });
        response.json({ ok: true, data: safeDriveConnection(saved, request) });
        return;
      }
      const token = connection?.access_token_ciphertext ? decrypt(connection.access_token_ciphertext) : "";
      if (token) {
        await fetch(\`https://oauth2.googleapis.com/revoke?token=\${encodeURIComponent(token)}\`, {
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

  router.post("/test-slide"`,
    "disconnect_route",
  );

  replaceRequired(
    /    <section id="google" class="panel tab-panel hide">[\s\S]*?    <\/section>/,
    `    <section id="google" class="panel tab-panel hide">
      <h2>Kết nối Google Drive</h2>
      <div class="notice"><b>Dùng lại kết nối Drive của ver7.</b> Không cần Client ID, Client Secret, Redirect URI hay thêm Variables trên webhook. Bấm “Kết nối Google Drive” để kiểm tra và sử dụng thư mục hiện tại.</div>
      <div id="google-state" class="connection-card"></div>
      <div class="actions oauth-actions">
        <button id="google-connect" type="button" class="primary">Kết nối Google Drive</button>
        <button id="google-switch" type="button" class="primary hide">Đổi tài khoản / thư mục Drive</button>
        <button id="google-test" type="button">Kiểm tra kết nối</button>
        <button id="google-disconnect" type="button">Ngắt kết nối</button>
      </div>
      <p class="secret-note">Khi đổi tài khoản, chỉ cần dán link thư mục gốc đã chia sẻ quyền xem. Mapping và danh sách ảnh hiện tại vẫn được giữ nguyên.</p>
    </section>`,
    "google_section",
  );

  replaceRequired(
    /    function renderConnection\(\) \{[\s\S]*?\n    \}\n\n    function renderTestResult/,
    `    function renderConnection() {
      const connection = data.drive_connection || {};
      const connected = Boolean(connection.connected || data.drive_connected);
      const account = connection.account_email || connection.account_name || '';
      const folder = connection.root_folder_id || '';
      const statusText = connected ? 'Đã kết nối' : 'Chưa kết nối';
      const detail = account || (folder ? 'Thư mục gốc: ' + folder : 'Chưa có thư mục Google Drive');
      byId('connection').innerHTML = '<div class="connection-head"><div><b>Google Drive</b><div class="muted">' + escapeHtml(detail) + '</div></div><span class="badge ' + (connected ? 'connected' : '') + '">' + statusText + '</span></div>';
      byId('google-state').innerHTML = '<div class="connection-head"><div><b>' + (connected ? 'Google Drive đang hoạt động' : 'Google Drive chưa hoạt động') + '</b><div class="muted">' + escapeHtml(detail) + '</div></div><span class="badge ' + (connected ? 'connected' : '') + '">' + statusText + '</span></div>' + (connection.last_error ? '<p class="bad">' + escapeHtml(connection.last_error) + '</p>' : '');
      byId('google-connect').classList.toggle('hide', connected);
      byId('google-switch').classList.toggle('hide', !connected);
      byId('google-test').disabled = !connection.configured;
      byId('google-disconnect').disabled = !connected;
    }

    function renderTestResult`,
    "render_connection",
  );

  replaceRequired(
    /    byId\('google-connect'\)\.addEventListener\('click', async \(\) => \{[\s\S]*?\n    \}\);\n\n    byId\('google-switch'\)\.addEventListener\('click', async \(\) => \{[\s\S]*?\n    \}\);/,
    `    byId('google-connect').addEventListener('click', async () => {
      try {
        setStatus('Đang kiểm tra Google Drive…');
        const result = await api('/google/connect');
        if (result.authorization_url) { location.href = result.authorization_url; return; }
        data.drive_connection = result.data || data.drive_connection;
        data.drive_connected = result.connected === true;
        renderConnection();
        setStatus('Đã kết nối Google Drive thành công.');
      } catch (error) { setStatus(error.message, false); }
    });

    byId('google-switch').addEventListener('click', async () => {
      const rootFolder = prompt('Dán link hoặc ID thư mục gốc Google Drive của tài khoản mới:');
      if (!rootFolder) return;
      try {
        setStatus('Đang kiểm tra thư mục Google Drive mới…');
        const result = await api('/google/root', { method: 'POST', body: JSON.stringify({ root_folder_url: rootFolder }) });
        data.drive_connection = result.data || data.drive_connection;
        data.drive_connected = result.connected === true;
        renderConnection();
        setStatus('Đã chuyển sang thư mục Google Drive mới.');
      } catch (error) { setStatus(error.message, false); }
    });`,
    "connect_handlers",
  );

  source = source.replace(
    "if (query.get('google') === 'connected') setStatus('Đã đăng nhập Google Drive thành công.');",
    "if (query.get('google') === 'connected') setStatus('Đã kết nối Google Drive thành công.');",
  );

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`DRIVE_V7_MODE_SYNTAX_FAILED:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Restored V7 Google Drive API-key connection mode");
}
