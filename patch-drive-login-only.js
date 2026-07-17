import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "drive-slide-manager.js";
let source = fs.readFileSync(file, "utf8");

if (source.includes("AIGUKA_DRIVE_LOGIN_ONLY")) {
  console.log("[AIGUKA] Drive login-only flow already patched");
} else {
  const replaceRequired = (pattern, replacement, label) => {
    if (!pattern.test(source)) throw new Error(`DRIVE_LOGIN_ONLY_ANCHOR_NOT_FOUND:${label}`);
    source = source.replace(pattern, replacement);
  };

  if (source.includes("// AIGUKA_SLIDE_V2")) {
    source = source.replace("// AIGUKA_SLIDE_V2", "// AIGUKA_SLIDE_V2\n// AIGUKA_DRIVE_LOGIN_ONLY");
  } else {
    source = source.replace('import express from "express";', 'import express from "express";\n\n// AIGUKA_DRIVE_LOGIN_ONLY');
  }

  replaceRequired(
    /  const safeDriveConnection = \(row, request\) => \(\{[\s\S]*?\n  \}\);/,
    `  const safeDriveConnection = (row, _request) => ({
    configured: Boolean(row?.client_id && row?.client_secret_ciphertext),
    connected: Boolean(row?.refresh_token_ciphertext || row?.access_token_ciphertext),
    enabled: row?.is_enabled !== false,
    status: row?.connection_status || "not_configured",
    root_folder_id: row?.root_folder_id || "",
    account_email: row?.account_email || "",
    account_name: row?.account_name || "",
    scope: row?.scope || "",
    last_checked_at: row?.last_checked_at || null,
    last_error: row?.last_error || null,
  });`,
    "safe_connection",
  );

  replaceRequired(
    /  router\.get\("\/google\/connect", async \(request, response\) => \{[\s\S]*?\n  \}\);\n\n  router\.get\("\/google\/callback"/,
    `  router.get("/google/connect", async (request, response) => {
    try {
      const connection = await getDriveConnection();
      if (!connection?.client_id || !connection?.client_secret_ciphertext) {
        throw new Error("Kết nối Google Drive của hệ thống chưa sẵn sàng. Quản trị kỹ thuật cần cấu hình ứng dụng Google một lần ở khu vực nội bộ.");
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
    "connect_route",
  );

  source = source.replace(
    'if (!connection?.client_id || !connection?.client_secret_ciphertext) throw new Error("Thiếu cấu hình OAuth Google Drive");',
    'if (!connection?.client_id || !connection?.client_secret_ciphertext) throw new Error("Kết nối Google Drive của hệ thống chưa sẵn sàng");',
  );

  replaceRequired(
    /    <section id="google" class="panel tab-panel hide">[\s\S]*?    <\/section>/,
    `    <section id="google" class="panel tab-panel hide">
      <h2>Kết nối Google Drive</h2>
      <div class="notice"><b>Chỉ cần đăng nhập tài khoản Google.</b> AIGUKA sẽ ghi nhớ quyền đọc/ghi để quản lý ảnh và thư mục. Khi tài khoản cũ không còn dùng được, bấm “Đổi tài khoản Google”.</div>
      <div id="google-state" class="connection-card"></div>
      <div class="actions oauth-actions">
        <button id="google-connect" type="button" class="primary">Đăng nhập Google Drive</button>
        <button id="google-switch" type="button" class="primary hide">Đổi tài khoản Google</button>
        <button id="google-test" type="button">Kiểm tra kết nối</button>
        <button id="google-disconnect" type="button">Ngắt kết nối</button>
      </div>
      <p class="secret-note">Không cần nhập Client ID, Client Secret, Redirect URI hoặc thêm Variables Google Drive trên webhook.</p>
    </section>`,
    "google_section",
  );

  replaceRequired(
    /    function renderConnection\(\) \{[\s\S]*?\n    \}\n\n    function renderTestResult/,
    `    function renderConnection() {
      const connection = data.drive_connection || {};
      const connected = Boolean(connection.connected || data.drive_connected);
      const account = connection.account_email || connection.account_name || '';
      const statusText = connected ? 'Đã kết nối' : 'Chưa đăng nhập';
      byId('connection').innerHTML = '<div class="connection-head"><div><b>Google Drive</b><div class="muted">' + escapeHtml(account || (connected ? 'Đã có quyền đọc và ghi' : 'Bấm Kết nối Google Drive để đăng nhập')) + '</div></div><span class="badge ' + (connected ? 'connected' : '') + '">' + statusText + '</span></div>';
      byId('google-state').innerHTML = '<div class="connection-head"><div><b>' + (connected ? 'Tài khoản Google Drive đang sử dụng' : 'Chưa kết nối tài khoản Google Drive') + '</b><div class="muted">' + escapeHtml(account || 'Đăng nhập để truy cập, thêm, sửa và xóa ảnh/thư mục') + '</div></div><span class="badge ' + (connected ? 'connected' : '') + '">' + statusText + '</span></div>' + (connection.last_error ? '<p class="bad">' + escapeHtml(connection.last_error) + '</p>' : '');
      byId('google-connect').classList.toggle('hide', connected);
      byId('google-switch').classList.toggle('hide', !connected);
      byId('google-test').disabled = !connected;
      byId('google-disconnect').disabled = !connected;
    }

    function renderTestResult`,
    "render_connection",
  );

  replaceRequired(
    /\n    byId\('google-form'\)\.addEventListener\('submit',[\s\S]*?\n    \}\);\n/,
    "\n",
    "remove_google_form",
  );

  replaceRequired(
    /    byId\('google-connect'\)\.addEventListener\('click', async \(\) => \{[\s\S]*?\n    \}\);/,
    `    byId('google-connect').addEventListener('click', async () => {
      try {
        setStatus('Đang mở trang đăng nhập Google…');
        const result = await api('/google/connect');
        location.href = result.authorization_url;
      } catch (error) { setStatus(error.message, false); }
    });

    byId('google-switch').addEventListener('click', async () => {
      if (!confirm('Đổi sang tài khoản Google Drive khác? Dữ liệu mapping hiện tại vẫn được giữ nguyên.')) return;
      try {
        setStatus('Đang mở trang chọn tài khoản Google…');
        const result = await api('/google/connect?switch=1');
        location.href = result.authorization_url;
      } catch (error) { setStatus(error.message, false); }
    });`,
    "connect_handlers",
  );

  source = source.replace(
    "if (!confirm('Ngắt quyền Google Drive khỏi AIGUKA? Client ID vẫn được giữ để có thể kết nối lại.')) return;",
    "if (!confirm('Ngắt tài khoản Google Drive khỏi AIGUKA? Mapping và danh sách ảnh vẫn được giữ nguyên.')) return;",
  );

  replaceRequired(
    /\n    byId\('copy-callback'\)\.addEventListener\('click',[\s\S]*?\n    \}\);\n/,
    "\n",
    "remove_copy_callback",
  );

  source = source.replace(
    "if (query.get('google') === 'connected') setStatus('Đã cấp quyền Google Drive thành công. Hãy bấm “Kiểm tra kết nối”.');",
    "if (query.get('google') === 'connected') setStatus('Đã đăng nhập Google Drive thành công.');",
  );

  fs.writeFileSync(file, source, "utf8");

  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) {
    throw new Error(`DRIVE_LOGIN_ONLY_SYNTAX_FAILED:${syntax.stderr || syntax.stdout}`);
  }
  console.log("[AIGUKA] Drive login-only UI installed; account switching enabled");
}
