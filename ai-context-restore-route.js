import express from "express";

const clean = (value = "") => String(value ?? "").trim();

export function installAiContextRestoreRoute(app, { supabaseUrl, publishableKey, serviceRoleKey }) {
  const key = serviceRoleKey || publishableKey;
  if (!supabaseUrl || !key) throw new Error("AI_CONTEXT_RESTORE_SUPABASE_NOT_CONFIGURED");
  const rest = async (path, init = {}) => {
    const response = await fetch(`${String(supabaseUrl).replace(/\/$/, "")}/rest/v1/${path}`, {
      method: init.method || "GET",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        prefer: "return=representation",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30000),
      cache: "no-store",
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error(data?.message || data?.error || `SUPABASE_${response.status}`);
    return data;
  };

  app.post("/api/ai-contexts/restore", express.json({ limit: "2mb" }), async (req, res) => {
    try {
      const contextId = clean(req.body?.context_id);
      const versionNo = Number(req.body?.version_no);
      if (!contextId || !Number.isFinite(versionNo)) throw new Error("Thiếu ngữ cảnh hoặc phiên bản cần khôi phục");
      const context = (await rest(`v8_ai_contexts?id=eq.${encodeURIComponent(contextId)}&select=*&limit=1`))?.[0];
      if (!context) throw new Error("Không tìm thấy ngữ cảnh");
      const version = (await rest(`v8_ai_context_versions?context_id=eq.${encodeURIComponent(contextId)}&version_no=eq.${versionNo}&select=*&limit=1`))?.[0];
      if (!version) throw new Error("Không tìm thấy phiên bản");
      const nextVersion = Number(context.current_version || 0) + 1;
      const metadata = { ...(context.metadata || {}), ...(version.metadata || {}), restored_from_version: versionNo };
      const row = {
        context_name: version.context_name,
        page_id: version.page_id || null,
        source_type: version.source_type || context.source_type || "manual",
        content: version.content || "",
        usage_mode: version.usage_mode || "OFF",
        priority: Number(version.priority || 100),
        is_active: version.is_active !== false,
        current_version: nextVersion,
        metadata,
        updated_by: "ai_context_restore",
        updated_at: new Date().toISOString(),
      };
      const saved = (await rest(`v8_ai_contexts?id=eq.${encodeURIComponent(contextId)}`, { method: "PATCH", body: row }))?.[0] || { ...context, ...row };
      await rest("v8_ai_context_versions", {
        method: "POST",
        body: {
          context_id: contextId,
          version_no: nextVersion,
          context_name: row.context_name,
          page_id: row.page_id,
          source_type: row.source_type,
          content: row.content,
          usage_mode: row.usage_mode,
          priority: row.priority,
          is_active: row.is_active,
          change_note: `Khôi phục phiên bản ${versionNo}`,
          metadata,
          created_by: "ai_context_restore",
        },
      });
      res.json({ ok: true, data: saved, restored_from_version: versionNo });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });
}
