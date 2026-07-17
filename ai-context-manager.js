import crypto from "node:crypto";

const clean = (value) => String(value ?? "").trim();
const clampText = (value, max = 300000) => String(value ?? "").slice(0, max);

export function installAiContextManager(app, options = {}) {
  const supabaseUrl = clean(options.supabaseUrl || process.env.SUPABASE_URL).replace(/\/$/, "");
  const serviceRoleKey = clean(options.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY);
  const publishableKey = clean(options.publishableKey || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY);
  const key = serviceRoleKey || publishableKey;
  if (!supabaseUrl || !key) throw new Error("AI_CONTEXT_SUPABASE_NOT_CONFIGURED");

  const headers = (prefer = "return=representation") => ({
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    Prefer: prefer,
    "x-aiguka-railway-test": "enabled",
    "x-aiguka-admin-secret": "AIGUKA_RAILWAY_TEST_MODE",
  });

  async function rest(path, request = {}) {
    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      method: request.method || "GET",
      headers: { ...headers(request.prefer), ...(request.headers || {}) },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(request.timeout || 60000),
      cache: "no-store",
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 1000) }; }
    if (!response.ok) throw new Error(data?.message || data?.error || `SUPABASE_HTTP_${response.status}`);
    return data;
  }

  function publicProvider(row = {}) {
    return {
      provider_key: row.provider_key,
      provider_name: row.provider_name,
      provider_type: row.provider_type || "openai_compatible",
      base_url: row.base_url || "",
      model_name: row.model_name || "",
      mode: row.mode || "OFF",
      is_enabled: row.is_enabled !== false,
      connection_status: row.connection_status || "unknown",
      available_models: Array.isArray(row.available_models) ? row.available_models : [],
      has_api_key: Boolean(row.api_key_ciphertext),
    };
  }

  function decryptProviderKey(value) {
    if (!serviceRoleKey) throw new Error("MISSING_SUPABASE_SERVICE_ROLE_KEY");
    const [ivPart, tagPart, dataPart] = String(value || "").split(".");
    if (!ivPart || !tagPart || !dataPart) throw new Error("AI_PROVIDER_KEY_FORMAT_INVALID");
    const encryptionKey = crypto
      .createHash("sha256")
      .update(`${serviceRoleKey}|${supabaseUrl}|AIGUKA_AI_PROVIDER_KEYS_V1`)
      .digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivPart, "base64"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8");
  }

  async function getContext(id) {
    const rows = await rest(`v8_ai_contexts?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    if (!rows?.[0]) throw new Error("CONTEXT_NOT_FOUND");
    return rows[0];
  }

  async function saveContext(payload = {}, actor = "ai_context_admin") {
    const id = clean(payload.id);
    const contextName = clean(payload.context_name);
    if (!contextName) throw new Error("CONTEXT_NAME_REQUIRED");
    const usageMode = clean(payload.usage_mode || "OFF").toUpperCase();
    if (!['OFF', 'TEST', 'PRODUCTION'].includes(usageMode)) throw new Error("CONTEXT_MODE_INVALID");
    const content = clampText(payload.content);
    const pageId = clean(payload.page_id) || null;
    const sourceType = clean(payload.source_type || "manual") || "manual";
    const priority = Math.min(Math.max(Number(payload.priority || 100), 0), 9999);
    const isActive = payload.is_active !== false;
    const metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
      ? payload.metadata
      : {};
    const changeNote = clampText(payload.change_note, 1000) || null;
    const now = new Date().toISOString();

    if (id) {
      const existing = await getContext(id);
      const versionNo = Number(existing.current_version || 0) + 1;
      const updateRows = await rest(`v8_ai_contexts?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: {
          context_name: contextName,
          page_id: pageId,
          source_type: sourceType,
          content,
          usage_mode: usageMode,
          priority,
          is_active: isActive,
          current_version: versionNo,
          metadata: { ...(existing.metadata || {}), ...metadata },
          updated_by: actor,
          updated_at: now,
        },
      });
      await rest("v8_ai_context_versions", {
        method: "POST",
        body: {
          context_id: id,
          version_no: versionNo,
          context_name: contextName,
          page_id: pageId,
          source_type: sourceType,
          content,
          usage_mode: usageMode,
          priority,
          is_active: isActive,
          change_note: changeNote,
          metadata: { ...(existing.metadata || {}), ...metadata },
          created_by: actor,
        },
      });
      return updateRows?.[0] || { ...existing, current_version: versionNo };
    }

    const contextKey = clean(payload.context_key) || `context_${crypto.randomBytes(10).toString("hex")}`;
    const created = await rest("v8_ai_contexts", {
      method: "POST",
      body: {
        context_key: contextKey,
        context_name: contextName,
        page_id: pageId,
        source_type: sourceType,
        content,
        usage_mode: usageMode,
        priority,
        is_active: isActive,
        current_version: 1,
        metadata,
        created_by: actor,
        updated_by: actor,
      },
    });
    const row = created?.[0];
    await rest("v8_ai_context_versions", {
      method: "POST",
      body: {
        context_id: row.id,
        version_no: 1,
        context_name: contextName,
        page_id: pageId,
        source_type: sourceType,
        content,
        usage_mode: usageMode,
        priority,
        is_active: isActive,
        change_note: changeNote || "Tạo ngữ cảnh",
        metadata,
        created_by: actor,
      },
    });
    return row;
  }

  async function callProvider(provider, systemText, userText, requestedModel) {
    if (!provider.api_key_ciphertext) throw new Error("AI_PROVIDER_HAS_NO_API_KEY");
    const apiKey = decryptProviderKey(provider.api_key_ciphertext);
    const type = provider.provider_type || "openai_compatible";
    const model = clean(requestedModel) || clean(provider.model_name) || provider.available_models?.[0];
    if (!model) throw new Error("AI_MODEL_NOT_CONFIGURED");
    const base = clean(provider.base_url).replace(/\/$/, "");

    if (type === "gemini") {
      const root = base || "https://generativelanguage.googleapis.com/v1beta";
      const modelName = model.replace(/^models\//, "");
      const response = await fetch(`${root}/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemText }] },
          contents: [{ role: "user", parts: [{ text: userText }] }],
          generationConfig: { temperature: 0.35, maxOutputTokens: 1200 },
        }),
        signal: AbortSignal.timeout(60000),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error?.message || `GEMINI_HTTP_${response.status}`);
      return { text: json.candidates?.[0]?.content?.parts?.map((x) => x.text || "").join("") || "", model: modelName };
    }

    if (type === "anthropic") {
      const response = await fetch(`${base || "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, system: systemText, max_tokens: 1200, temperature: 0.35, messages: [{ role: "user", content: userText }] }),
        signal: AbortSignal.timeout(60000),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error?.message || `ANTHROPIC_HTTP_${response.status}`);
      return { text: json.content?.map((x) => x.text || "").join("") || "", model };
    }

    if (!["openai_compatible", "mistral", "groq", "openrouter", "together", "xai"].includes(type)) {
      throw new Error(`CONTEXT_TEST_PROVIDER_NOT_SUPPORTED:${type}`);
    }
    const response = await fetch(`${base || "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        max_tokens: 1200,
        messages: [
          { role: "system", content: systemText },
          { role: "user", content: userText },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error?.message || json.message || `AI_HTTP_${response.status}`);
    return { text: json.choices?.[0]?.message?.content || "", model };
  }

  app.use("/api/ai-contexts", app.json({ limit: "5mb" }));

  app.get("/api/ai-contexts", async (_req, res) => {
    try {
      const [contexts, versions, pages, providers, logs] = await Promise.all([
        rest("v8_ai_contexts?select=*&order=priority.asc,updated_at.desc"),
        rest("v8_ai_context_versions?select=*&order=created_at.desc&limit=500"),
        rest("v8_pages?select=page_id,page_name,bot_mode,is_active&is_active=eq.true&order=page_name.asc"),
        rest("v8_ai_providers?select=*&order=provider_name.asc"),
        rest("v8_ai_context_test_logs?select=id,context_id,page_id,provider_key,model_name,input_text,output_text,status,error_message,latency_ms,created_at&order=created_at.desc&limit=50"),
      ]);
      res.json({
        ok: true,
        contexts: contexts || [],
        versions: versions || [],
        pages: pages || [],
        providers: (providers || []).map(publicProvider),
        test_logs: logs || [],
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ai-contexts/save", async (req, res) => {
    try {
      const row = await saveContext(req.body || {});
      res.json({ ok: true, data: row });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ai-contexts/restore", async (req, res) => {
    try {
      const contextId = clean(req.body?.context_id);
      const versionNo = Number(req.body?.version_no || 0);
      const context = await getContext(contextId);
      const versions = await rest(`v8_ai_context_versions?context_id=eq.${encodeURIComponent(contextId)}&version_no=eq.${versionNo}&select=*&limit=1`);
      const version = versions?.[0];
      if (!version) throw new Error("CONTEXT_VERSION_NOT_FOUND");
      const row = await saveContext({
        id: contextId,
        context_name: version.context_name,
        page_id: version.page_id,
        source_type: version.source_type,
        content: version.content,
        usage_mode: version.usage_mode,
        priority: version.priority,
        is_active: version.is_active,
        metadata: { ...(version.metadata || {}), restored_from_version: versionNo },
        change_note: `Khôi phục từ phiên bản ${versionNo}`,
      }, "ai_context_restore");
      res.json({ ok: true, data: row });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.delete("/api/ai-contexts/:id", async (req, res) => {
    try {
      const context = await getContext(req.params.id);
      await saveContext({
        ...context,
        id: context.id,
        usage_mode: "OFF",
        is_active: false,
        metadata: { ...(context.metadata || {}), archived_at: new Date().toISOString() },
        change_note: "Lưu trữ ngữ cảnh",
      }, "ai_context_archive");
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ai-contexts/test", async (req, res) => {
    const started = Date.now();
    let contextId = null;
    let providerKey = null;
    let pageId = null;
    let inputText = "";
    try {
      contextId = clean(req.body?.context_id);
      providerKey = clean(req.body?.provider_key);
      pageId = clean(req.body?.page_id) || null;
      inputText = clampText(req.body?.input_text, 20000);
      if (!contextId || !inputText) throw new Error("CONTEXT_AND_TEST_MESSAGE_REQUIRED");
      const selected = await getContext(contextId);
      const allContexts = await rest("v8_ai_contexts?is_active=eq.true&select=*&order=priority.asc,updated_at.asc");
      const included = (allContexts || []).filter((row) => {
        if (row.id === contextId) return true;
        return row.usage_mode === "TEST" && (!row.page_id || row.page_id === (pageId || selected.page_id));
      });
      const contextBundle = included
        .map((row) => `### ${row.context_name}\n${row.content || ""}`)
        .filter((x) => x.trim())
        .join("\n\n");
      const systemText = `${contextBundle}\n\n### QUY TẮC KIỂM THỬ AIGUKA\nĐây là môi trường TEST, không gửi tin tới khách thật. Trả lời tự nhiên, ngắn gọn, đúng ngữ cảnh; không bịa giá, tồn kho, chính sách hoặc thông tin chưa có trong ngữ cảnh. Khi thiếu dữ liệu, nói rõ và hỏi đúng một câu cần thiết.`;

      let providers = await rest(`v8_ai_providers?select=*&${providerKey ? `provider_key=eq.${encodeURIComponent(providerKey)}` : "is_enabled=eq.true"}&order=updated_at.desc`);
      let provider = providers?.[0];
      if (!provider && !providerKey) {
        providers = await rest("v8_ai_providers?select=*&order=updated_at.desc&limit=1");
        provider = providers?.[0];
      }
      if (!provider) throw new Error("NO_AI_PROVIDER_CONFIGURED");
      providerKey = provider.provider_key;
      const result = await callProvider(provider, systemText, inputText, req.body?.model_name);
      const latency = Date.now() - started;
      await rest("v8_ai_context_test_logs", {
        method: "POST",
        body: {
          context_id: contextId,
          page_id: pageId || selected.page_id || null,
          provider_key: providerKey,
          model_name: result.model,
          input_text: inputText,
          output_text: result.text,
          status: "completed",
          latency_ms: latency,
          metadata: { included_context_ids: included.map((x) => x.id), safe_test_only: true },
        },
      });
      res.json({ ok: true, output_text: result.text, model_name: result.model, provider_key: providerKey, latency_ms: latency, included_contexts: included.map((x) => ({ id: x.id, name: x.context_name })) });
    } catch (error) {
      const latency = Date.now() - started;
      try {
        await rest("v8_ai_context_test_logs", {
          method: "POST",
          body: { context_id: contextId || null, page_id: pageId, provider_key: providerKey, input_text: inputText || "[empty]", status: "error", error_message: error.message, latency_ms: latency, metadata: { safe_test_only: true } },
        });
      } catch {}
      res.status(400).json({ ok: false, error: error.message, latency_ms: latency });
    }
  });

  app.get("/ai-contexts", (_req, res) => {
    res.type("html").send(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quản lý ngữ cảnh AI</title><style>
:root{--blue:#2563eb;--purple:#7357b8;--line:#d9e1ec;--bg:#f4f6fa;--text:#172033;--muted:#667085;--green:#067647;--red:#b42318}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px Arial,sans-serif}.shell{max-width:1720px;margin:auto;padding:12px}.top{background:linear-gradient(90deg,#637ce5,#7a4faa);color:#fff;padding:14px 18px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center}.top h2{margin:0;font-size:18px}.top a{color:#fff;text-decoration:none;border:1px solid #ffffff66;padding:8px 11px;border-radius:7px}.app{display:grid;grid-template-columns:210px 1fr;background:#fff;border:1px solid var(--line);border-top:0;border-radius:0 0 12px 12px;min-height:760px}.side{background:#f7f9fc;border-right:1px solid var(--line);padding:12px 0}.side button{display:block;width:100%;border:0;background:transparent;text-align:left;padding:13px 18px;cursor:pointer;font-weight:700}.side button.active{background:#dcebff;color:#154ec1;border-left:4px solid var(--blue)}.main{padding:18px 22px;min-width:0}.view{display:none}.view.active{display:block}.layout{display:grid;grid-template-columns:300px 1fr;gap:14px}.panel{border:1px solid var(--line);border-radius:10px;background:#fff;padding:13px}.toolbar{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.toolbar button,.btn{border:1px solid #b9c6d8;background:#fff;padding:8px 11px;border-radius:7px;cursor:pointer}.primary{background:var(--blue)!important;border-color:var(--blue)!important;color:#fff}.danger{background:var(--red)!important;border-color:var(--red)!important;color:#fff}.green{background:var(--green)!important;border-color:var(--green)!important;color:#fff}.context-list{max-height:660px;overflow:auto;margin-top:10px}.context-item{border:1px solid var(--line);border-radius:8px;padding:10px;margin:7px 0;cursor:pointer}.context-item.active{border-color:var(--blue);background:#eff6ff}.badge{display:inline-block;border-radius:999px;padding:3px 7px;font-size:11px;background:#eef2f6;margin:2px}.badge.TEST{background:#fff0c2;color:#854d0e}.badge.PRODUCTION{background:#dcfae6;color:#067647}.badge.OFF{background:#fee4e2;color:#b42318}.grid{display:grid;grid-template-columns:2fr 1fr 1fr 100px;gap:9px}.field{display:flex;flex-direction:column;gap:5px}.field label{font-weight:700;color:#344054}.field input,.field select,.field textarea,textarea{width:100%;border:1px solid #cbd5e1;border-radius:7px;padding:9px;font:inherit}.editor-tools{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.editor-tools button{border:1px solid #80aaff;background:#fff;color:#155eef;padding:7px 9px;border-radius:6px;cursor:pointer}.context-editor{min-height:520px;resize:vertical;line-height:1.55;font-family:Arial,sans-serif}.meta-line{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:6px}.notice{padding:10px 12px;border:1px solid #f5c26b;background:#fff7df;border-radius:8px;margin:10px 0}.safe{border-color:#8ad4aa;background:#ecfdf3;color:#05603a}.test-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.test-grid textarea{min-height:250px;white-space:pre-wrap}.history-row,.log-row{border-bottom:1px solid var(--line);padding:10px 4px}.status{position:fixed;right:14px;bottom:14px;background:#067647;color:#fff;padding:9px 12px;border-radius:999px;z-index:50}.status.bad{background:#b42318}.file-label{display:inline-block;border:1px solid #80aaff;color:#155eef;padding:7px 9px;border-radius:6px;cursor:pointer}.file-label input{display:none}@media(max-width:1000px){.app{grid-template-columns:1fr}.side{display:flex;overflow:auto;border-right:0;border-bottom:1px solid var(--line)}.side button{min-width:max-content}.layout,.test-grid{grid-template-columns:1fr}.grid{grid-template-columns:1fr 1fr}.context-editor{min-height:390px}}@media(max-width:560px){.grid{grid-template-columns:1fr}.main{padding:12px}}
</style></head><body><div class="shell"><div class="top"><div><h2>Quản lý ngữ cảnh AI</h2><div>Nhập ngữ cảnh AIcake, quản lý phiên bản và thử nghiệm an toàn trong AIGUKA</div></div><div><a href="/learning-reviewed">AI Học & Prompt</a> <a href="/dashboard">Dashboard</a></div></div><div class="app"><aside class="side"><button class="active" data-view="editor">✎ Ngữ cảnh</button><button data-view="test">🤖 Test AI</button><button data-view="history">☷ Lịch sử chỉnh sửa</button><button data-view="import">⇩ Nhập từ AIcake</button></aside><main class="main">
<section id="view-editor" class="view active"><div class="layout"><div class="panel"><div class="toolbar"><button class="primary" onclick="newContext()">+ Thêm</button><button onclick="loadAll()">↻ Tải lại</button></div><div id="context-list" class="context-list"></div></div><div class="panel"><div class="grid"><div class="field"><label>Tên ngữ cảnh</label><input id="context-name" placeholder="Default Context"></div><div class="field"><label>Áp dụng cho Page</label><select id="context-page"></select></div><div class="field"><label>Chế độ sử dụng</label><select id="context-mode"><option>OFF</option><option>TEST</option><option>PRODUCTION</option></select></div><div class="field"><label>Ưu tiên</label><input id="context-priority" type="number" value="100"></div></div><div class="editor-tools"><button onclick="insertSnippet('company')">⌘ Chèn thông tin</button><button onclick="insertSnippet('product')">＋ Chèn bảng sản phẩm</button><button onclick="insertSnippet('media')">▧ Chèn link ảnh/video</button><button onclick="insertSnippet('attachment')">⌕ Chèn link tệp đính kèm</button><button onclick="insertSnippet('url')">▦ Chèn dữ liệu từ link</button><label class="file-label">Nhập tệp TXT/MD/JSON<input id="context-file" type="file" accept=".txt,.md,.json,text/plain,application/json" onchange="importFile(this.files[0])"></label><button onclick="pasteClipboard()">Dán từ clipboard</button></div><textarea id="context-content" class="context-editor" placeholder="Dán toàn bộ nội dung Default Context của AIcake vào đây..."></textarea><div class="meta-line"><span id="char-count">0 ký tự</span><span id="version-label">Chưa lưu phiên bản</span></div><div class="field" style="margin-top:9px"><label>Ghi chú phiên bản</label><input id="change-note" placeholder="Ví dụ: Nhập nguyên bản AIcake lần đầu"></div><div class="notice safe"><b>An toàn:</b> Ngữ cảnh mới mặc định OFF. Nút Test AI chỉ tạo phản hồi xem trước và không gửi tới Facebook/Meta.</div><div class="toolbar"><button class="primary" onclick="saveCurrent()">▣ Lưu phiên bản</button><button onclick="duplicateCurrent()">Tạo bản sao</button><button id="archive-button" class="danger" onclick="archiveCurrent()">Lưu trữ</button></div></div></div></section>
<section id="view-test" class="view"><div class="panel"><h3>Test AI với ngữ cảnh đã chọn</h3><div class="notice safe">Kết quả chỉ hiển thị tại đây, tuyệt đối không gửi cho khách. Ngữ cảnh đang OFF vẫn có thể được chọn để thử riêng.</div><div class="grid"><div class="field"><label>Ngữ cảnh</label><select id="test-context"></select></div><div class="field"><label>Page mô phỏng</label><select id="test-page"></select></div><div class="field"><label>Nền tảng AI</label><select id="test-provider"></select></div><div class="field"><label>Model</label><input id="test-model" placeholder="Để trống dùng model mặc định"></div></div><div class="test-grid" style="margin-top:12px"><div class="field"><label>Tin nhắn khách</label><textarea id="test-input" placeholder="Ví dụ: Mình muốn xem mẫu quạt trần cho phòng khách 30m²"></textarea></div><div class="field"><label>Phản hồi AI</label><textarea id="test-output" readonly></textarea></div></div><div class="toolbar" style="margin-top:12px"><button class="green" onclick="runTest()">▶ Chạy Test AI</button><span id="test-info" class="badge"></span></div><h3>Lịch sử test gần nhất</h3><div id="test-logs"></div></div></section>
<section id="view-history" class="view"><div class="panel"><h3>Lịch sử phiên bản</h3><div class="field"><label>Chọn ngữ cảnh</label><select id="history-context" onchange="renderHistory()"></select></div><div id="history-list" style="margin-top:12px"></div></div></section>
<section id="view-import" class="view"><div class="panel"><h3>Chuyển ngữ cảnh từ AIcake</h3><div class="notice"><b>Cách chuyển đầy đủ:</b> mở AIcake → Default Context → chọn toàn bộ nội dung → sao chép → quay lại đây và bấm “Dán từ clipboard”. Ảnh chụp màn hình chỉ thể hiện một phần nên không thể dùng để khôi phục toàn bộ ngữ cảnh.</div><ol><li>Chọn ngữ cảnh “AIcake — Default Context” hoặc tạo bản mới.</li><li>Dán nguyên văn, không chỉnh sửa trong lần nhập đầu.</li><li>Lưu với chế độ OFF.</li><li>Qua mục Test AI để thử nhiều tình huống.</li><li>Chỉ bật TEST sau khi kết quả ổn định; chưa bật PRODUCTION.</li></ol><div class="toolbar"><button class="primary" onclick="openAicakeImport()">Mở ngữ cảnh nhập AIcake</button><button onclick="createAicakeCopy()">Tạo bản nhập AIcake mới</button></div></div></section>
</main></div></div><div id="status" class="status">Đang tải…</div><script>
let D={contexts:[],versions:[],pages:[],providers:[],test_logs:[]},currentId=null;const $=id=>document.getElementById(id),E=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));function st(text,ok=true){$('status').textContent=text;$('status').className='status'+(ok?'':' bad')}async function api(url,options){const r=await fetch(url,options),t=await r.text();let j;try{j=t?JSON.parse(t):{}}catch{j={error:t}}if(!r.ok||j.ok===false)throw Error(j.error||j.message||('HTTP '+r.status));return j}function pageOptions(selected=''){return '<option value="">Toàn bộ Page</option>'+D.pages.map(x=>'<option value="'+E(x.page_id)+'" '+(x.page_id===selected?'selected':'')+'>'+E(x.page_name)+'</option>').join('')}function contextOptions(selected=''){return D.contexts.filter(x=>x.is_active).map(x=>'<option value="'+E(x.id)+'" '+(x.id===selected?'selected':'')+'>'+E(x.context_name)+'</option>').join('')}function renderLists(){const active=D.contexts.filter(x=>x.is_active);$('context-list').innerHTML=active.map(x=>'<div class="context-item '+(x.id===currentId?'active':'')+'" onclick="selectContext(\''+x.id+'\')"><b>'+E(x.context_name)+'</b><br><span class="badge '+E(x.usage_mode)+'">'+E(x.usage_mode)+'</span><span class="badge">v'+E(x.current_version||0)+'</span><div class="muted">'+E(D.pages.find(p=>p.page_id===x.page_id)?.page_name||'Toàn bộ Page')+'</div></div>').join('')||'<div class="muted">Chưa có ngữ cảnh.</div>';$('context-page').innerHTML=pageOptions($('context-page').value);$('test-page').innerHTML=pageOptions($('test-page').value);$('test-context').innerHTML=contextOptions($('test-context').value||currentId);$('history-context').innerHTML=contextOptions($('history-context').value||currentId);$('test-provider').innerHTML=D.providers.map(x=>'<option value="'+E(x.provider_key)+'">'+E(x.provider_name)+' · '+E(x.model_name||'chưa chọn model')+'</option>').join('')||'<option value="">Chưa cấu hình AI</option>';renderLogs();renderHistory()}function selectContext(id){const x=D.contexts.find(row=>row.id===id);if(!x)return;currentId=id;$('context-name').value=x.context_name||'';$('context-page').innerHTML=pageOptions(x.page_id||'');$('context-mode').value=x.usage_mode||'OFF';$('context-priority').value=x.priority||100;$('context-content').value=x.content||'';$('change-note').value='';$('version-label').textContent='Phiên bản hiện tại: v'+(x.current_version||0);$('archive-button').style.display='inline-block';$('test-context').value=id;$('history-context').value=id;updateCount();renderLists()}function newContext(){currentId=null;$('context-name').value='Ngữ cảnh mới';$('context-page').innerHTML=pageOptions('');$('context-mode').value='OFF';$('context-priority').value='100';$('context-content').value='';$('change-note').value='';$('version-label').textContent='Chưa lưu phiên bản';$('archive-button').style.display='none';updateCount();renderLists()}function payload(){const old=D.contexts.find(x=>x.id===currentId);return{id:currentId,context_name:$('context-name').value.trim(),page_id:$('context-page').value||null,source_type:old?.source_type||'manual',content:$('context-content').value,usage_mode:$('context-mode').value,priority:Number($('context-priority').value||100),is_active:true,change_note:$('change-note').value.trim(),metadata:{...(old?.metadata||{}),last_edited_from:'ai_context_manager'}}}async function saveCurrent(){if(!$('context-name').value.trim())return st('Cần nhập tên ngữ cảnh.',false);if($('context-mode').value==='PRODUCTION'&&!confirm('Bật ngữ cảnh này cho PRODUCTION? Chỉ tiếp tục khi đã test kỹ.'))return;st('Đang lưu phiên bản…');try{const j=await api('/api/ai-contexts/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload())});currentId=j.data.id;await loadAll();selectContext(currentId);st('Đã lưu phiên bản mới')}catch(e){st(e.message,false)}}async function archiveCurrent(){if(!currentId||!confirm('Lưu trữ ngữ cảnh này?'))return;try{await api('/api/ai-contexts/'+encodeURIComponent(currentId),{method:'DELETE'});currentId=null;await loadAll();newContext();st('Đã lưu trữ ngữ cảnh')}catch(e){st(e.message,false)}}function duplicateCurrent(){const x=D.contexts.find(row=>row.id===currentId);if(!x)return newContext();currentId=null;$('context-name').value=(x.context_name||'Ngữ cảnh')+' — Bản sao';$('context-mode').value='OFF';$('change-note').value='Tạo bản sao để thử nghiệm';$('version-label').textContent='Bản sao chưa lưu';renderLists()}function insertAtCursor(text){const a=$('context-content'),s=a.selectionStart||0,e=a.selectionEnd||0;a.value=a.value.slice(0,s)+text+a.value.slice(e);a.selectionStart=a.selectionEnd=s+text.length;a.focus();updateCount()}function insertSnippet(type){const map={company:'\n\n====================\nTHÔNG TIN DOANH NGHIỆP\n====================\nTên thương hiệu:\nĐịa chỉ:\nHotline:\nChính sách chính:\n',product:'\n\n====================\nBẢNG SẢN PHẨM\n====================\nTên sản phẩm | Giá/khung giá | Đặc điểm | Link ảnh/slide\n',media:'\n[Ảnh/Video: DÁN_LINK_CÔNG_KHAI_TẠI_ĐÂY]\n',attachment:'\n[Tệp đính kèm: DÁN_LINK_TỆP_TẠI_ĐÂY]\n',url:'\n[Dữ liệu tham khảo từ URL: DÁN_LINK_TẠI_ĐÂY]\n'};insertAtCursor(map[type]||'')}async function pasteClipboard(){try{const text=await navigator.clipboard.readText();if(!text)throw Error('Clipboard đang trống');$('context-content').value=text;updateCount();st('Đã dán '+text.length+' ký tự từ clipboard')}catch(e){st('Trình duyệt không cho đọc clipboard. Hãy Ctrl+V trực tiếp vào ô nội dung.',false)}}function importFile(file){if(!file)return;const reader=new FileReader();reader.onload=()=>{let text=String(reader.result||'');if(file.name.toLowerCase().endsWith('.json')){try{const j=JSON.parse(text);text=typeof j==='string'?j:(j.content||j.context||j.prompt||JSON.stringify(j,null,2))}catch{}}$('context-content').value=text;updateCount();st('Đã nhập '+file.name)};reader.onerror=()=>st('Không đọc được tệp.',false);reader.readAsText(file,'utf-8')}function updateCount(){$('char-count').textContent=$('context-content').value.length.toLocaleString('vi-VN')+' ký tự'}async function runTest(){const id=$('test-context').value;if(!id)return st('Chưa chọn ngữ cảnh.',false);if(!$('test-input').value.trim())return st('Chưa nhập tin nhắn thử.',false);$('test-output').value='';st('AI đang tạo phản hồi TEST…');try{const j=await api('/api/ai-contexts/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({context_id:id,page_id:$('test-page').value||null,provider_key:$('test-provider').value||null,model_name:$('test-model').value.trim()||null,input_text:$('test-input').value})});$('test-output').value=j.output_text||'';$('test-info').textContent=(j.provider_key||'AI')+' · '+(j.model_name||'')+' · '+j.latency_ms+'ms';await loadAll(false);st('Đã tạo phản hồi TEST, không gửi cho khách')}catch(e){st(e.message,false)}}function renderLogs(){$('test-logs').innerHTML=(D.test_logs||[]).slice(0,20).map(x=>'<div class="log-row"><b>'+E(D.contexts.find(c=>c.id===x.context_id)?.context_name||'Ngữ cảnh đã xóa')+'</b> · '+E(x.provider_key||'')+' · '+E(x.model_name||'')+' · '+E(x.latency_ms||0)+'ms<br><span class="muted">'+E(new Date(x.created_at).toLocaleString('vi-VN'))+'</span><details><summary>Xem câu hỏi và trả lời</summary><pre style="white-space:pre-wrap">KHÁCH: '+E(x.input_text)+'\n\nAI: '+E(x.output_text||x.error_message||'')+'</pre></details></div>').join('')||'<div class="muted">Chưa có lần test.</div>'}function renderHistory(){const id=$('history-context')?.value||currentId;if(!id)return;$('history-list').innerHTML=(D.versions||[]).filter(x=>x.context_id===id).map(x=>'<div class="history-row"><b>Phiên bản '+E(x.version_no)+'</b> · '+E(x.usage_mode)+' · '+E(new Date(x.created_at).toLocaleString('vi-VN'))+'<br><span class="muted">'+E(x.change_note||'Không có ghi chú')+'</span><div class="toolbar" style="margin-top:6px"><button onclick="previewVersion(\''+x.id+'\')">Xem</button><button onclick="restoreVersion('+Number(x.version_no)+')">Khôi phục</button></div></div>').join('')||'<div class="muted">Chưa có lịch sử.</div>'}function previewVersion(id){const x=D.versions.find(v=>v.id===id);if(!x)return;alert('PHIÊN BẢN '+x.version_no+'\n\n'+x.content.slice(0,12000))}async function restoreVersion(versionNo){const id=$('history-context').value;if(!id||!confirm('Khôi phục phiên bản '+versionNo+'? Hệ thống vẫn tạo một phiên bản mới để có thể hoàn tác.'))return;try{await api('/api/ai-contexts/restore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({context_id:id,version_no:versionNo})});currentId=id;await loadAll();selectContext(id);st('Đã khôi phục phiên bản '+versionNo)}catch(e){st(e.message,false)}}function openAicakeImport(){const x=D.contexts.find(c=>c.context_key==='aicake_default_import')||D.contexts.find(c=>c.source_type==='aicake_import');document.querySelector('[data-view="editor"]').click();if(x)selectContext(x.id);else createAicakeCopy()}function createAicakeCopy(){document.querySelector('[data-view="editor"]').click();newContext();$('context-name').value='AIcake — Default Context '+new Date().toLocaleDateString('vi-VN');$('change-note').value='Nhập nguyên bản từ AIcake';$('context-mode').value='OFF'}async function loadAll(select=true){try{const j=await api('/api/ai-contexts');D=j;renderLists();if(select){const desired=D.contexts.find(x=>x.id===currentId&&x.is_active)||D.contexts.find(x=>x.context_key==='aicake_default_import'&&x.is_active)||D.contexts.find(x=>x.is_active);if(desired)selectContext(desired.id);else newContext()}st('Đã tải '+D.contexts.filter(x=>x.is_active).length+' ngữ cảnh')}catch(e){st(e.message,false)}}document.querySelectorAll('.side button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.side button').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('view-'+b.dataset.view).classList.add('active');if(b.dataset.view==='history')renderHistory()});$('context-content').addEventListener('input',updateCount);loadAll();
</script></body></html>`);
  });
}
