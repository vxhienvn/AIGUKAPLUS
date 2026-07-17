import fs from "node:fs";

const file = "drive-slide-manager.js";
let source = fs.readFileSync(file, "utf8");

if (source.includes("AIGUKA_SLIDE_V2")) {
  console.log("[AIGUKA] Slide manager V2 already patched");
  process.exitCode = 0;
} else {
  const replaceRequired = (needle, replacement, label) => {
    if (!source.includes(needle)) throw new Error(`SLIDE_V2_ANCHOR_NOT_FOUND:${label}`);
    source = source.replace(needle, replacement);
  };

  replaceRequired(
    'import express from "express";',
    'import express from "express";\nimport sharp from "sharp";\n\n// AIGUKA_SLIDE_V2',
    "sharp_import",
  );

  const oldPublicUrl = `  const publicAssetUrl = (request, asset) => {
    return \`\${requestOrigin(request)}/api/slide-manager/image/\${encodeURIComponent(asset.id)}\`;
  };`;
  const newPublicUrl = `  const publicAssetUrl = (request, asset, variant = "send") => {
    const value = ["thumb", "send", "original"].includes(String(variant)) ? String(variant) : "send";
    return \`\${requestOrigin(request)}/api/slide-manager/image/\${encodeURIComponent(asset.id)}?variant=\${value}\`;
  };

  const originalAssetUrl = (asset) => (
    asset.file_url
    || (asset.drive_file_id ? \`https://drive.google.com/file/d/\${encodeURIComponent(asset.drive_file_id)}/view\` : "")
    || asset.delivery_url
    || "#"
  );

  const optimizeAssetImage = async (asset, variant = "send") => {
    const image = await fetchAssetImage(asset);
    if (variant === "original") return image;
    const isThumb = variant === "thumb";
    const buffer = await sharp(image.buffer, { failOn: "none", limitInputPixels: 80_000_000 })
      .rotate()
      .resize({
        width: isThumb ? 420 : 1600,
        height: isThumb ? 320 : 1600,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: isThumb ? 72 : 82, progressive: true, mozjpeg: true })
      .toBuffer();
    return {
      ...image,
      buffer,
      contentType: "image/jpeg",
      optimized: true,
      variant,
    };
  };

  const recentRecipients = async (pageId) => {
    const selectedPage = String(pageId || "").trim();
    if (!selectedPage) return [];
    const [customers, messages] = await Promise.all([
      db(\`v8_customers?select=id,page_id,sender_id,display_name,last_seen_at&Page_id=eq.\${encodeURIComponent(selectedPage)}&sender_id=not.is.null&order=last_seen_at.desc&limit=700\`.replace("Page_id", "page_id")),
      db(\`v8_messages_raw?select=customer_id,page_id,sent_at,direction,actor_type&Page_id=eq.\${encodeURIComponent(selectedPage)}&or=(direction.eq.inbound,direction.eq.incoming,actor_type.eq.customer)&order=sent_at.desc&limit=5000\`.replace("Page_id", "page_id")),
    ]);
    const lastInbound = new Map();
    for (const message of messages || []) {
      const customerId = String(message.customer_id || "");
      if (!customerId || lastInbound.has(customerId)) continue;
      lastInbound.set(customerId, message.sent_at || null);
    }
    const now = Date.now();
    return (customers || [])
      .map((customer) => {
        const lastInboundAt = lastInbound.get(String(customer.id)) || null;
        const ageMs = lastInboundAt ? now - new Date(lastInboundAt).getTime() : Number.POSITIVE_INFINITY;
        return {
          customer_id: customer.id,
          page_id: customer.page_id,
          sender_id: String(customer.sender_id || ""),
          label: customer.display_name || \`Khách ...\${String(customer.sender_id || "").slice(-6)}\`,
          last_inbound_at: lastInboundAt,
          within_24h: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 24 * 60 * 60 * 1000,
          age_hours: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 360000) / 10) : null,
        };
      })
      .filter((row) => /^\\d{5,32}$/.test(row.sender_id) && row.last_inbound_at)
      .sort((left, right) => new Date(right.last_inbound_at) - new Date(left.last_inbound_at));
  };`;
  replaceRequired(oldPublicUrl, newPublicUrl, "asset_urls");

  const imageRoutePattern = /  router\.get\("\/image\/:id", async \(request, response\) => \{[\s\S]*?\n  \}\);\n\n  router\.get\("\/google\/status"/;
  if (!imageRoutePattern.test(source)) throw new Error("SLIDE_V2_ANCHOR_NOT_FOUND:image_route");
  source = source.replace(imageRoutePattern, `  router.get("/image/:id", async (request, response) => {
    try {
      const rows = await db(\`v8_drive_assets?id=eq.\${encodeURIComponent(request.params.id)}&is_active=eq.true&deleted_from_drive_at=is.null&select=*&limit=1\`);
      const asset = rows?.[0];
      if (!asset) throw new Error("Không tìm thấy ảnh đang hoạt động");
      const variant = ["thumb", "send", "original"].includes(String(request.query.variant)) ? String(request.query.variant) : "send";
      const image = await optimizeAssetImage(asset, variant);
      response.set({
        "content-type": image.contentType,
        "content-length": String(image.buffer.length),
        "cache-control": variant === "original" ? "private, max-age=300" : "public, max-age=86400, stale-while-revalidate=604800",
        "content-disposition": \`inline; filename="\${String(asset.file_name || "slide.jpg").replace(/["\\\\]/g, "_")}"\`,
        "x-content-type-options": "nosniff",
        "x-aiguka-image-variant": variant,
      });
      response.send(image.buffer);
    } catch (error) {
      response.status(404).json({ ok: false, error: error.message });
    }
  });

  router.get("/recipients", async (request, response) => {
    try {
      const rows = await recentRecipients(request.query.page_id);
      response.json({ ok: true, data: rows.slice(0, 250), eligible_count: rows.filter((row) => row.within_24h).length });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get("/google/status"`);

  const testRoutePattern = /  router\.post\("\/test-slide", async \(request, response\) => \{[\s\S]*?\n  \}\);\n\n  app\.use\("\/api\/slide-manager", router\);/;
  if (!testRoutePattern.test(source)) throw new Error("SLIDE_V2_ANCHOR_NOT_FOUND:test_route");
  source = source.replace(testRoutePattern, `  router.post("/test-slide", async (request, response) => {
    try {
      const body = request.body || {};
      const pageId = String(body.page_id || "").trim();
      const recipientId = String(body.recipient_id || "").trim();
      if (!pageId || !recipientId) throw new Error("Cần chọn Trang và một khách từ hội thoại gần đây");
      if (!body.mapping_id) throw new Error("Cần chọn mapping sản phẩm");

      const recipients = await recentRecipients(pageId);
      const recipient = recipients.find((item) => item.sender_id === recipientId);
      if (!recipient) throw new Error("Khách này không thuộc hội thoại của Trang đã chọn. Hãy chọn lại từ danh sách tự động.");
      if (!recipient.within_24h) throw new Error("Hội thoại đã quá 24 giờ nên Meta không cho gửi RESPONSE. Hãy nhắn thử vào Trang rồi tải lại danh sách.");

      const mappingRows = await db(\`v8_slide_mapping?id=eq.\${encodeURIComponent(body.mapping_id)}&is_active=eq.true&select=*\`);
      const mapping = mappingRows?.[0];
      if (!mapping) throw new Error("Mapping không tồn tại hoặc đã tắt");
      if (mapping.page_id && String(mapping.page_id) !== pageId) throw new Error("Mapping này được gán cho Trang khác");

      const allAssets = await db(
        \`v8_drive_assets?product_key=eq.\${encodeURIComponent(mapping.product_key)}&is_active=eq.true&deleted_from_drive_at=is.null&select=*&order=sort_order.asc\`,
      );
      if ((allAssets || []).length < 5) {
        throw new Error(\`Slide cần tối thiểu 5 ảnh; mapping hiện chỉ có \${(allAssets || []).length} ảnh. Hãy bổ sung ảnh trước khi gửi.\`);
      }
      const assets = (allAssets || []).slice(0, 10);
      const token = await pageToken(pageId);
      if (!token) throw new Error("Không tìm thấy Page Access Token của Trang đã chọn");

      const prepared = [];
      for (const asset of assets) {
        const checkedImage = await optimizeAssetImage(asset, "send");
        prepared.push({
          asset,
          url: publicAssetUrl(request, asset, "send"),
          original_url: originalAssetUrl(asset),
          content_type: checkedImage.contentType,
          optimized_bytes: checkedImage.buffer.length,
        });
      }

      const graphUrl = \`https://graph.facebook.com/v23.0/\${encodeURIComponent(pageId)}/messages?access_token=\${encodeURIComponent(token)}\`;
      const sendRequest = async (message) => {
        const metaResponse = await fetch(graphUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            recipient: { id: recipientId },
            messaging_type: "RESPONSE",
            message,
          }),
          signal: AbortSignal.timeout(45_000),
        });
        const metaData = await metaResponse.json().catch(() => ({}));
        if (!metaResponse.ok || metaData.error) {
          const metaError = new Error(metaData.error?.message || \`META_\${metaResponse.status}\`);
          metaError.meta = metaData.error || {};
          throw metaError;
        }
        return metaData;
      };

      const results = [];
      let batchMode = true;
      try {
        const metaData = await sendRequest({
          attachments: prepared.map((item) => ({ type: "image", payload: { url: item.url } })),
        });
        for (const [index, item] of prepared.entries()) {
          results.push({
            asset_id: item.asset.id,
            file_name: item.asset.file_name,
            position: index + 1,
            url: item.url,
            original_url: item.original_url,
            content_type: item.content_type,
            optimized_bytes: item.optimized_bytes,
            ok: true,
            message_id: metaData.message_id,
            recipient_id: metaData.recipient_id,
            batch_mode: true,
          });
        }
      } catch (batchError) {
        batchMode = false;
        const code = Number(batchError.meta?.code || 0);
        if (code === 100 || /cannot send messages to this id|recipient/i.test(batchError.message)) {
          throw new Error("Meta từ chối người nhận: PSID không thuộc Trang hoặc hội thoại không còn quyền gửi. Hãy chọn khách trong danh sách tự động và nhắn mới vào Trang.");
        }
        for (const [index, item] of prepared.entries()) {
          try {
            const metaData = await sendRequest({ attachment: { type: "image", payload: { url: item.url, is_reusable: true } } });
            results.push({ asset_id: item.asset.id, file_name: item.asset.file_name, position: index + 1, url: item.url, original_url: item.original_url, content_type: item.content_type, optimized_bytes: item.optimized_bytes, ok: true, message_id: metaData.message_id, recipient_id: metaData.recipient_id, batch_mode: false });
          } catch (error) {
            results.push({ asset_id: item.asset.id, file_name: item.asset.file_name, position: index + 1, url: item.url, original_url: item.original_url, content_type: item.content_type, optimized_bytes: item.optimized_bytes, ok: false, error: error.message, meta_error: error.meta || null, batch_mode: false });
          }
        }
      }

      await db("v8_slide_logs", {
        method: "POST",
        body: JSON.stringify(results.map((result) => ({
          page_id: pageId,
          sender_id: recipientId,
          product_key: mapping.product_key,
          slide_url: result.original_url || result.url,
          send_status: result.ok ? "sent" : "failed",
          send_error: result.error || null,
          sent_at: result.ok ? new Date().toISOString() : null,
          decision_status: "runtime_test",
          safety_status: "recent_page_conversation",
          reason: {
            message_id: result.message_id || null,
            mapping_id: mapping.id,
            channel: "meta_send_api",
            delivery_url: result.url,
            original_url: result.original_url,
            content_type: result.content_type,
            optimized_bytes: result.optimized_bytes,
            batch_mode: result.batch_mode,
            recipient_last_inbound_at: recipient.last_inbound_at,
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
        available_total: (allAssets || []).length,
        success_count: successCount,
        failure_count: results.length - successCount,
        batch_mode: batchMode,
        recipient,
        results,
      });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  app.use("/api/slide-manager", router);`);

  replaceRequired(
    '<div><label>Người nhận thử (PSID dạng số)</label><input id="recipient" list="recipient-list" inputmode="numeric" pattern="[0-9]{5,32}" placeholder="Ví dụ: 28308705945387770"><datalist id="recipient-list"></datalist></div>',
    '<div><label>Khách nhận thử từ hội thoại của Trang</label><select id="recipient"><option value="">Đang tải hội thoại gần đây…</option></select><div id="recipient-hint" class="muted" style="margin-top:5px"></div></div>',
    "recipient_selector",
  );
  replaceRequired(
    '<p class="notice"><b>Lưu ý:</b> PSID là dãy số của khách trên đúng Trang Facebook. Tên người dùng, username hoặc đường dẫn hồ sơ Facebook không gửi được qua Meta Send API.</p>\n      <p class="muted">Ảnh được đọc qua máy chủ AIGUKA, kiểm tra định dạng image/*, gửi từng ảnh qua Meta và ghi lại message_id.</p>',
    '<p class="notice"><b>Không cần nhập ID.</b> AIGUKA tự lấy khách đã nhắn đúng Trang và chỉ cho chọn hội thoại còn trong cửa sổ gửi của Meta.</p>\n      <p class="muted">Mỗi slide gửi 5–10 ảnh đã thu nhỏ và chuẩn hóa JPEG. Ảnh xem trước là thumbnail; bấm vào ảnh để mở tệp gốc trên Google Drive.</p>',
    "test_notice",
  );
  replaceRequired(
    "const previewUrl = (asset) => '/api/slide-manager/image/' + encodeURIComponent(asset.id);",
    "const previewUrl = (asset) => '/api/slide-manager/image/' + encodeURIComponent(asset.id) + '?variant=thumb';\n    const originalUrl = (asset) => asset.file_url || (asset.drive_file_id ? 'https://drive.google.com/file/d/' + encodeURIComponent(asset.drive_file_id) + '/view' : (asset.delivery_url || '#'));",
    "preview_urls",
  );
  replaceRequired(
    "'<tr><td><img class=\"thumb\" loading=\"lazy\" alt=\"' + escapeHtml(row.file_name) + '\" src=\"' + escapeHtml(previewUrl(row)) + '\"></td>'",
    "'<tr><td><a href=\"' + escapeHtml(originalUrl(row)) + '\" target=\"_blank\" rel=\"noopener\"><img class=\"thumb\" loading=\"lazy\" alt=\"' + escapeHtml(row.file_name) + '\" src=\"' + escapeHtml(previewUrl(row)) + '\"></a></td>'",
    "asset_thumbnail_link",
  );
  replaceRequired(
    "byId('recipient-list').innerHTML = data.recipients.map((recipient) => '<option value=\"' + escapeHtml(recipient.sender_id) + '\">' + escapeHtml(recipient.label || recipient.sender_id) + '</option>').join('');",
    "byId('recipient').innerHTML = '<option value=\"\">Chọn Trang để tải khách gần đây</option>';",
    "recipient_render",
  );
  replaceRequired(
    "'<div class=\"preview-card\"><img class=\"thumb\" alt=\"' + escapeHtml(asset.file_name) + '\" src=\"' + escapeHtml(previewUrl(asset)) + '\"><span>' + (index + 1) + '. ' + escapeHtml(asset.file_name) + '</span></div>'",
    "'<div class=\"preview-card\"><a href=\"' + escapeHtml(originalUrl(asset)) + '\" target=\"_blank\" rel=\"noopener\"><img class=\"thumb\" loading=\"lazy\" alt=\"' + escapeHtml(asset.file_name) + '\" src=\"' + escapeHtml(previewUrl(asset)) + '\"></a><span>' + (index + 1) + '. ' + escapeHtml(asset.file_name) + '</span></div>'",
    "preview_thumbnail_link",
  );

  const loadRecipientsAnchor = `    function renderTestResult(result) {`;
  const loadRecipientsCode = `    async function loadRecipients() {
      const pageId = byId('test-page').value;
      const select = byId('recipient');
      const hint = byId('recipient-hint');
      if (!pageId) { select.innerHTML = '<option value="">Chưa có Trang hoạt động</option>'; return; }
      select.disabled = true;
      select.innerHTML = '<option value="">Đang tải khách đã nhắn Trang…</option>';
      hint.textContent = '';
      try {
        const result = await api('/recipients?page_id=' + encodeURIComponent(pageId));
        const rows = result.data || [];
        const eligible = rows.filter((row) => row.within_24h);
        select.innerHTML = '<option value="">Chọn khách nhận thử (' + eligible.length + ' hội thoại còn hạn)</option>' + eligible.map((row) => '<option value="' + escapeHtml(row.sender_id) + '">' + escapeHtml(row.label) + ' · ' + escapeHtml(row.age_hours) + ' giờ trước</option>').join('');
        hint.textContent = eligible.length ? 'Chỉ hiển thị khách đã nhắn đúng Trang trong 24 giờ gần nhất.' : 'Chưa có hội thoại còn hạn. Hãy nhắn vào Trang bằng Messenger rồi tải lại.';
      } catch (error) {
        select.innerHTML = '<option value="">Không tải được khách</option>';
        hint.textContent = error.message;
      } finally { select.disabled = false; }
    }

`;
  replaceRequired(loadRecipientsAnchor, loadRecipientsCode + loadRecipientsAnchor, "load_recipients");

  replaceRequired(
    "byId('test-mapping').addEventListener('change', renderPreview);",
    "byId('test-mapping').addEventListener('change', renderPreview);\n    byId('test-page').addEventListener('change', loadRecipients);",
    "page_recipient_change",
  );
  replaceRequired(
    "if (!/^[0-9]{5,32}$/.test(recipient)) { setStatus('PSID phải là dãy số; không dùng username Facebook', false); return; }",
    "if (!recipient) { setStatus('Hãy chọn một khách từ hội thoại gần đây của Trang', false); return; }",
    "recipient_validation",
  );
  replaceRequired(
    "setStatus(result.all_sent ? 'Đã gửi thử toàn bộ slide.' : 'Có ảnh gửi thất bại; xem kết quả chi tiết.', result.all_sent);",
    "setStatus(result.all_sent ? 'Đã gửi thử ' + result.total + ' ảnh đã tối ưu.' : 'Có ảnh gửi thất bại; xem kết quả chi tiết.', result.all_sent);",
    "test_status",
  );
  replaceRequired(
    "render();\n      setStatus('Đã tải ' + data.mappings.length + ' mapping và ' + data.assets.length + ' ảnh.');",
    "render();\n      await loadRecipients();\n      setStatus('Đã tải ' + data.mappings.length + ' mapping và ' + data.assets.length + ' ảnh.');",
    "load_recipients_on_start",
  );

  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA] Slide V2: auto recipient, 5-10 optimized images, Drive original links");
}
