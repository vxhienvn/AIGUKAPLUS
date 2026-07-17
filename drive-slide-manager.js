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
  const driveToken = () => process.env.GOOGLE_DRIVE_ACCESS_TOKEN || "";

  const router = express.Router();
  router.use(express.json({ limit: "18mb" }));

  router.get("/data", async (_request, response) => {
    try {
      const [mappings, assets, pages, recipients] = await Promise.all([
        db("v8_slide_mapping?select=*&order=priority.asc,product_name.asc"),
        db("v8_drive_assets?select=*&deleted_from_drive_at=is.null&order=product_key.asc,sort_order.asc"),
        db("v8_pages?select=page_id,page_name,is_active&is_active=eq.true&order=page_name.asc"),
        db("v8_runtime_test_recipients?select=*&is_active=eq.true&order=label.asc"),
      ]);
      response.json({
        ok: true,
        mappings: mappings || [],
        assets: assets || [],
        pages: pages || [],
        recipients: recipients || [],
        drive_connected: Boolean(driveToken()),
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
        if (!driveToken()) throw new Error("Chưa kết nối quyền ghi Google Drive");
        const driveResponse = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(asset.drive_file_id)}`,
          { method: "DELETE", headers: { authorization: `Bearer ${driveToken()}` } },
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
      if (!driveToken()) throw new Error("Chưa kết nối quyền ghi Google Drive");
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
          authorization: `Bearer ${driveToken()}`,
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
      const url = String(body.url || "");
      if (!url) throw new Error("Ảnh chưa có URL giao trực tiếp");
      const imageResponse = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
      const contentType = imageResponse.headers.get("content-type") || "";
      const valid = imageResponse.ok && contentType.toLowerCase().startsWith("image/");
      if (body.id) {
        await db(`v8_drive_assets?id=eq.${encodeURIComponent(body.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            delivery_status: valid ? "ready" : "invalid",
            delivery_http_status: imageResponse.status,
            delivery_content_type: contentType || null,
            delivery_error: valid ? null : "URL không trả về tệp ảnh trực tiếp",
            delivery_checked_at: new Date().toISOString(),
          }),
        });
      }
      response.json({
        ok: valid,
        http_status: imageResponse.status,
        content_type: contentType,
        final_url: imageResponse.url,
        error: valid ? null : "URL không trả về tệp ảnh trực tiếp",
      });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/test-slide", async (request, response) => {
    try {
      const body = request.body || {};
      if (!body.page_id || !body.recipient_id) throw new Error("Cần chọn Trang và nhập PSID người nhận thử");
      if (!body.mapping_id) throw new Error("Cần chọn mapping sản phẩm");

      const mappingRows = await db(`v8_slide_mapping?id=eq.${encodeURIComponent(body.mapping_id)}&is_active=eq.true&select=*`);
      const mapping = mappingRows?.[0];
      if (!mapping) throw new Error("Mapping không tồn tại hoặc đã tắt");
      const assets = await db(
        `v8_drive_assets?product_key=eq.${encodeURIComponent(mapping.product_key)}&is_active=eq.true&deleted_from_drive_at=is.null&select=*&order=sort_order.asc`,
      );
      const urls = (assets || []).map((asset) => asset.delivery_url || asset.file_url).filter(Boolean);
      if (!urls.length) throw new Error("Mapping chưa có ảnh đang hoạt động");

      const token = await pageToken(body.page_id);
      if (!token) throw new Error("Không tìm thấy Page Access Token của Trang đã chọn");
      const results = [];
      for (const url of urls) {
        try {
          const imageResponse = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
          const contentType = imageResponse.headers.get("content-type") || "";
          if (!imageResponse.ok || !contentType.toLowerCase().startsWith("image/")) {
            throw new Error(`URL ảnh không hợp lệ: HTTP ${imageResponse.status}, ${contentType || "không có content-type"}`);
          }
          const metaResponse = await fetch(
            `https://graph.facebook.com/v23.0/${encodeURIComponent(body.page_id)}/messages?access_token=${encodeURIComponent(token)}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                recipient: { id: body.recipient_id },
                messaging_type: "RESPONSE",
                message: { attachment: { type: "image", payload: { url, is_reusable: true } } },
              }),
            },
          );
          const metaData = await metaResponse.json();
          if (!metaResponse.ok) throw new Error(metaData.error?.message || `META_${metaResponse.status}`);
          results.push({ url, ok: true, message_id: metaData.message_id, recipient_id: metaData.recipient_id });
        } catch (error) {
          results.push({ url, ok: false, error: error.message });
        }
      }

      await db("v8_slide_logs", {
        method: "POST",
        body: JSON.stringify(results.map((result) => ({
          page_id: body.page_id,
          sender_id: body.recipient_id,
          product_key: mapping.product_key,
          slide_url: result.url,
          send_status: result.ok ? "sent" : "failed",
          send_error: result.error || null,
          sent_at: result.ok ? new Date().toISOString() : null,
          decision_status: "runtime_test",
          safety_status: "manual_test",
          reason: {
            message_id: result.message_id || null,
            mapping_id: mapping.id,
            channel: "meta_send_api",
            visibility_targets: ["messenger", "meta_business_suite", "pancake"],
          },
        }))),
      });
      response.json({ ok: true, all_sent: results.every((result) => result.ok), mapping, total: results.length, results });
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
  <title>Mapping, Google Drive & Test slide</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#172033;font:14px Arial,sans-serif}.wrap{max-width:1500px;margin:auto;padding:22px}.top,.panel{background:#fff;border:1px solid #d5deea;border-radius:12px;padding:16px;margin-bottom:14px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px}.top h1{margin:0 0 8px}.tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}.tabs button.active,.primary{background:#155eef;color:#fff;border-color:#155eef}button,input,select,textarea{border:1px solid #bdc9da;border-radius:7px;padding:8px;background:#fff}button{cursor:pointer}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.wide{grid-column:span 2}label{display:block;font-weight:700;font-size:12px;margin:4px 0}table{width:100%;border-collapse:collapse}th,td{border:1px solid #cbd5e1;padding:8px;text-align:left;vertical-align:top}th{background:#eaf0f8}.hide{display:none!important}.ok{color:#067647}.bad{color:#b42318}.muted{color:#667085}.actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.thumb{width:76px;height:58px;object-fit:cover;border-radius:5px;border:1px solid #d5deea}.result{white-space:pre-wrap;background:#0f172a;color:#d1fae5;padding:12px;border-radius:8px;max-height:300px;overflow:auto}.status{padding:10px 12px;margin-bottom:14px;border:1px solid #93c5fd;background:#eff6ff;border-radius:8px}.status.bad{border-color:#fda29b;background:#fef3f2;color:#b42318}.empty{text-align:center;color:#667085;padding:18px}.table-wrap{overflow:auto}.loading{opacity:.6;pointer-events:none}@media(max-width:800px){.wrap{padding:12px}.top{align-items:flex-start;flex-direction:column}.grid{grid-template-columns:1fr}.wide{grid-column:auto}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div><h1>Mapping, Google Drive & Test slide</h1><div class="muted">Chạy thử bằng Meta Send API để kiểm tra đúng luồng hiển thị trên Messenger, Meta Business Suite và Pancake.</div></div>
      <a href="/dashboard">Về bảng điều khiển</a>
    </div>
    <div id="status" class="status">Đang tải dữ liệu…</div>
    <div class="tabs">
      <button type="button" class="active" data-tab="mapping">Mapping</button>
      <button type="button" data-tab="assets">Ảnh & thư mục Drive</button>
      <button type="button" data-tab="test">Chạy thử slide</button>
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
      <div id="connection" class="muted" style="margin-bottom:10px"></div>
      <form id="asset-form" class="grid">
        <input type="hidden" name="id">
        <div><label>Mã sản phẩm</label><input name="product_key" required></div>
        <div><label>Tên sản phẩm</label><input name="product_name"></div>
        <div><label>Tên tệp</label><input name="file_name" required></div>
        <div><label>ID hoặc URL tệp Drive</label><input name="drive_file_id" required></div>
        <div class="wide"><label>URL ảnh trực tiếp (tự tạo nếu bỏ trống)</label><input name="delivery_url"></div>
        <div><label>Tên thư mục</label><input name="parent_folder_name"></div>
        <div><label>ID/URL thư mục</label><input name="parent_folder_id"></div>
        <div><label>Thứ tự</label><input name="sort_order" type="number" value="1000"></div>
        <div class="actions"><button class="primary">Lưu ảnh</button><button id="asset-new" type="button">Thêm mới</button></div>
      </form>
      <div class="actions" style="margin:12px 0"><input id="new-folder" placeholder="Tên thư mục mới"><input id="parent-folder" placeholder="ID thư mục cha (không bắt buộc)"><button id="create-folder" type="button">+ Tạo thư mục Drive</button></div>
      <div class="table-wrap"><table><thead><tr><th>Ảnh</th><th>Sản phẩm / thư mục</th><th>URL giao ảnh</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody id="asset-rows"></tbody></table></div>
    </section>

    <section id="test" class="panel tab-panel hide">
      <h2>Chạy thẳng slide qua Meta</h2>
      <div class="grid">
        <div><label>Trang Facebook</label><select id="test-page"></select></div>
        <div><label>Người nhận thử (PSID)</label><input id="recipient" list="recipient-list" placeholder="ID người dùng theo Trang"><datalist id="recipient-list"></datalist></div>
        <div><label>Mapping sản phẩm</label><select id="test-mapping"></select></div>
        <div style="align-self:end"><button id="run-test" type="button" class="primary">▶ Gửi thử toàn bộ slide</button></div>
      </div>
      <p class="muted">Hệ thống lấy ảnh đang hoạt động trực tiếp từ mapping, kiểm tra từng URL phải trả về image/*, rồi gửi từng ảnh bằng Meta Send API và ghi lại message_id.</p>
      <div id="preview" class="actions"></div>
      <pre id="result" class="result">Chưa chạy thử.</pre>
    </section>
  </div>
  <script>
    let data = { mappings: [], assets: [], pages: [], recipients: [] };
    const byId = (id) => document.getElementById(id);
    const escapeHtml = ${esc.toString()};

    function setStatus(message, ok = true) {
      const element = byId("status");
      element.textContent = message;
      element.className = "status" + (ok ? "" : " bad");
    }

    async function api(path, options = {}) {
      const response = await fetch("/api/slide-manager" + path, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers || {}) },
      });
      const text = await response.text();
      let json;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text || "Phản hồi không hợp lệ" }; }
      if (!response.ok || json.ok === false) throw new Error(json.error || "Có lỗi xảy ra");
      return json;
    }

    function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
    function resetForm(id) { const form = byId(id); form.reset(); if (form.elements.id) form.elements.id.value = ""; }
    function fillForm(form, row) {
      if (!row) return;
      Object.entries(row).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value ?? ""; });
    }

    function openTab(id) {
      document.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === id));
      document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("hide", panel.id !== id));
      if (id === "test") renderPreview();
    }

    function renderMappings() {
      const counts = new Map();
      data.assets.filter((asset) => asset.is_active).forEach((asset) => counts.set(asset.product_key, (counts.get(asset.product_key) || 0) + 1));
      byId("mapping-rows").innerHTML = data.mappings.length ? data.mappings.map((row) => (
        '<tr><td><b>' + escapeHtml(row.product_name) + '</b><br><small>' + escapeHtml(row.product_key) + '</small></td>'
        + '<td><a target="_blank" rel="noopener" href="' + escapeHtml(row.drive_folder_url || "#") + '">' + escapeHtml(row.drive_folder_id || "Chưa có") + '</a></td>'
        + '<td>' + escapeHtml(row.page_id || "Tất cả") + '</td><td>' + (counts.get(row.product_key) || 0) + '</td>'
        + '<td><div class="actions"><button type="button" data-action="edit-mapping" data-id="' + escapeHtml(row.id) + '">Sửa</button>'
        + '<button type="button" data-action="delete-mapping" data-id="' + escapeHtml(row.id) + '">Xóa</button></div></td></tr>'
      )).join("") : '<tr><td colspan="5" class="empty">Chưa có mapping.</td></tr>';
    }

    function renderAssets() {
      byId("asset-rows").innerHTML = data.assets.length ? data.assets.map((row) => (
        '<tr><td><img class="thumb" alt="' + escapeHtml(row.file_name) + '" src="' + escapeHtml(row.delivery_url || row.file_url || "") + '"></td>'
        + '<td><b>' + escapeHtml(row.file_name) + '</b><br>' + escapeHtml(row.product_key) + ' · ' + escapeHtml(row.parent_folder_name || "") + '</td>'
        + '<td><small>' + escapeHtml(row.delivery_url || "") + '</small></td><td>' + escapeHtml(row.delivery_status || "Chưa kiểm tra") + '</td>'
        + '<td><div class="actions"><button type="button" data-action="check-asset" data-id="' + escapeHtml(row.id) + '">Kiểm tra</button>'
        + '<button type="button" data-action="edit-asset" data-id="' + escapeHtml(row.id) + '">Sửa</button>'
        + '<button type="button" data-action="remove-asset" data-id="' + escapeHtml(row.id) + '">Gỡ danh mục</button>'
        + '<button type="button" data-action="delete-drive" data-id="' + escapeHtml(row.id) + '">Xóa Drive</button></div></td></tr>'
      )).join("") : '<tr><td colspan="5" class="empty">Chưa có ảnh.</td></tr>';
    }

    function renderSelectors() {
      const allPages = '<option value="">Tất cả Trang</option>' + data.pages.map((page) => '<option value="' + escapeHtml(page.page_id) + '">' + escapeHtml(page.page_name) + '</option>').join("");
      byId("mapping-page").innerHTML = allPages;
      byId("test-page").innerHTML = data.pages.map((page) => '<option value="' + escapeHtml(page.page_id) + '">' + escapeHtml(page.page_name) + '</option>').join("");
      byId("test-mapping").innerHTML = data.mappings.map((mapping) => '<option value="' + escapeHtml(mapping.id) + '">' + escapeHtml(mapping.product_name) + '</option>').join("");
      byId("recipient-list").innerHTML = data.recipients.map((recipient) => '<option value="' + escapeHtml(recipient.sender_id) + '">' + escapeHtml(recipient.label || recipient.sender_id) + '</option>').join("");
    }

    function renderPreview() {
      const mapping = data.mappings.find((row) => row.id === byId("test-mapping").value) || data.mappings[0];
      const assets = data.assets.filter((asset) => mapping && asset.product_key === mapping.product_key && asset.is_active).sort((left, right) => left.sort_order - right.sort_order);
      byId("preview").innerHTML = assets.length
        ? assets.map((asset) => '<img class="thumb" title="' + escapeHtml(asset.file_name) + '" src="' + escapeHtml(asset.delivery_url || asset.file_url || "") + '">').join("")
        : '<span class="muted">Mapping này chưa có ảnh hoạt động.</span>';
    }

    function render() { renderSelectors(); renderMappings(); renderAssets(); renderPreview(); }

    async function load() {
      setStatus("Đang tải mapping và ảnh…");
      data = await api("/data");
      byId("connection").textContent = "Google Drive ghi: " + (data.drive_connected ? "Đã kết nối" : "Chưa kết nối quyền ghi") + " · Meta gửi thử: " + (data.meta_connected ? "Đã kết nối" : "Chưa kết nối");
      render();
      setStatus("Đã tải " + data.mappings.length + " mapping và " + data.assets.length + " ảnh.");
    }

    async function removeMapping(id) {
      if (!confirm("Xóa mapping này?")) return;
      await api("/mapping/" + encodeURIComponent(id), { method: "DELETE" });
      await load();
    }

    async function removeAsset(id, fromDrive) {
      const message = fromDrive ? "Xóa thật tệp trên Google Drive? Thao tác này không hoàn tác." : "Gỡ ảnh khỏi danh mục AIGUKA?";
      if (!confirm(message)) return;
      await api("/asset/" + encodeURIComponent(id) + "?drive=" + fromDrive, { method: "DELETE" });
      await load();
    }

    async function checkAsset(id) {
      const asset = data.assets.find((row) => row.id === id);
      if (!asset) throw new Error("Không tìm thấy ảnh");
      const result = await api("/check", { method: "POST", body: JSON.stringify({ id, url: asset.delivery_url || asset.file_url }) });
      setStatus("URL ảnh hợp lệ: " + result.content_type);
      await load();
    }

    document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => openTab(button.dataset.tab)));
    byId("mapping-new").addEventListener("click", () => resetForm("mapping-form"));
    byId("asset-new").addEventListener("click", () => resetForm("asset-form"));
    byId("test-mapping").addEventListener("change", renderPreview);

    byId("mapping-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        setStatus("Đang lưu mapping…");
        await api("/mapping", { method: "POST", body: JSON.stringify(formObject(event.currentTarget)) });
        resetForm("mapping-form");
        await load();
      } catch (error) { setStatus(error.message, false); }
    });

    byId("asset-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        setStatus("Đang lưu ảnh…");
        await api("/asset", { method: "POST", body: JSON.stringify(formObject(event.currentTarget)) });
        resetForm("asset-form");
        await load();
      } catch (error) { setStatus(error.message, false); }
    });

    byId("create-folder").addEventListener("click", async () => {
      try {
        setStatus("Đang tạo thư mục Google Drive…");
        const result = await api("/drive/folder", { method: "POST", body: JSON.stringify({ name: byId("new-folder").value, parent_id: byId("parent-folder").value }) });
        byId("new-folder").value = "";
        setStatus("Đã tạo thư mục " + result.data.name + " · " + result.data.id);
      } catch (error) { setStatus(error.message, false); }
    });

    document.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const id = button.dataset.id;
      try {
        if (button.dataset.action === "edit-mapping") {
          fillForm(byId("mapping-form"), data.mappings.find((row) => row.id === id));
          openTab("mapping"); window.scrollTo({ top: 0, behavior: "smooth" });
        } else if (button.dataset.action === "delete-mapping") await removeMapping(id);
        else if (button.dataset.action === "edit-asset") {
          fillForm(byId("asset-form"), data.assets.find((row) => row.id === id));
          openTab("assets"); window.scrollTo({ top: 0, behavior: "smooth" });
        } else if (button.dataset.action === "check-asset") await checkAsset(id);
        else if (button.dataset.action === "remove-asset") await removeAsset(id, false);
        else if (button.dataset.action === "delete-drive") await removeAsset(id, true);
      } catch (error) { setStatus(error.message, false); }
    });

    byId("run-test").addEventListener("click", async () => {
      const mappingId = byId("test-mapping").value;
      if (!mappingId) { setStatus("Chưa có mapping để chạy thử", false); return; }
      byId("result").textContent = "Đang kiểm tra ảnh và gửi qua Meta…";
      try {
        const result = await api("/test-slide", {
          method: "POST",
          body: JSON.stringify({ page_id: byId("test-page").value, recipient_id: byId("recipient").value.trim(), mapping_id: mappingId }),
        });
        byId("result").textContent = JSON.stringify(result, null, 2);
        setStatus(result.all_sent ? "Đã gửi thử toàn bộ slide." : "Có ảnh gửi thất bại; xem kết quả chi tiết.", result.all_sent);
      } catch (error) {
        byId("result").textContent = "Lỗi: " + error.message;
        setStatus(error.message, false);
      }
    });

    load().catch((error) => setStatus(error.message, false));
  </script>
</body>
</html>`;
}
