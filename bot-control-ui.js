import fs from "node:fs";

export function installBotControlUi(app, options) {
  const { supabaseUrl, serviceRoleKey, publishableKey } = options;
  const key = serviceRoleKey || publishableKey;
  const headers = () => ({ apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", "x-aiguka-railway-test": "enabled", "x-aiguka-admin-secret": "AIGUKA_RAILWAY_TEST_MODE" });
  async function rest(path, request = {}) {
    if (!key) throw new Error("MISSING_SUPABASE_SERVICE_ROLE_KEY");
    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { method: request.method || "GET", headers: { ...headers(), Prefer: "return=representation" }, body: request.body === undefined ? undefined : JSON.stringify(request.body), signal: AbortSignal.timeout(40000), cache: "no-store" });
    const text = await response.text(); let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    if (!response.ok) throw new Error(data?.message || data?.error || `REST_HTTP_${response.status}`);
    return data;
  }
  async function rpc(name, args = {}) {
    if (!key) throw new Error("MISSING_SUPABASE_SERVICE_ROLE_KEY");
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, { method: "POST", headers: headers(), body: JSON.stringify(args), signal: AbortSignal.timeout(40000), cache: "no-store" });
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    if (!response.ok) throw new Error(data?.message || data?.error || `RPC_HTTP_${response.status}`);
    return data;
  }
  app.use("/bot-control", app.json({ limit: "1mb" }));
  app.get("/bot-control/api/state", async (_req, res) => {
    try {
      const [pages, settings, config, capabilities] = await Promise.all([
        rest("v8_pages?select=*&order=page_name.asc"),
        rest("bot_working_settings?select=*&setting_key=eq.default&limit=1"),
        rest("v8_config_hub?select=*&key=eq.runtime_mode&scope=eq.global&is_active=eq.true&order=updated_at.desc&limit=1"),
        rest("v8_page_messaging_capabilities?select=*&order=page_id.asc"),
      ]);
      const enriched = [];
      for (const page of pages || []) {
        let policy = null;
        try { const rows = await rpc("v8_resolve_runtime_policy", { p_page_id: page.page_id }); policy = Array.isArray(rows) ? rows[0] : rows; } catch {}
        enriched.push({ ...page, policy });
      }
      res.json({ ok: true, pages: enriched, settings: settings?.[0] || null, runtime: config?.[0] || null, capabilities: capabilities || [] });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });
  app.post("/bot-control/api/runtime", async (req, res) => {
    try {
      const body = req.body || {};
      const value = {
        mode: String(body.mode || "OBSERVE").toUpperCase(), queue_first: body.queue_first !== false,
        aiguka_can_send_text: !!body.aiguka_can_send_text, aiguka_can_send_image: !!body.aiguka_can_send_image,
        aiguka_can_auto_reply: !!body.aiguka_can_auto_reply, aiguka_can_create_sale_task: body.aiguka_can_create_sale_task !== false,
        meta_is_source_of_truth: true, aiguka_can_queue_internal: true,
      };
      const rows = await rest("v8_config_hub?key=eq.runtime_mode&scope=eq.global&is_active=eq.true", { method: "PATCH", body: { value, updated_at: new Date().toISOString() } });
      res.json({ ok: true, data: rows?.[0] || rows });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });
  app.post("/bot-control/api/page-mode", async (req, res) => {
    try {
      const body = req.body || {};
      const data = await rpc("v8_set_runtime_mode", { p_page_id: String(body.page_id || ""), p_target_mode: String(body.mode || "OBSERVE"), p_requested_by: "railway_bot_control" });
      res.json({ ok: true, data });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });
  app.post("/bot-control/api/schedule", async (req, res) => {
    try {
      const body = req.body || {};
      const payload = {
        timezone: body.timezone || "Asia/Ho_Chi_Minh", work_start: body.work_start || "08:00", work_end: body.work_end || "22:00",
        is_open: body.is_open !== false, holiday_mode: !!body.holiday_mode, staff_online_count: Number(body.staff_online_count || 0),
        admin_pause_minutes: Number(body.admin_pause_minutes || 10), customer_wait_minutes: Number(body.customer_wait_minutes || 5),
        working_wait_minutes: Number(body.working_wait_minutes || 5), outside_wait_minutes: Number(body.outside_wait_minutes || 5),
        reply_windows: Array.isArray(body.reply_windows) ? body.reply_windows : [],
        working_windows: Array.isArray(body.working_windows) ? body.working_windows : [],
        after_hours_windows: Array.isArray(body.after_hours_windows) ? body.after_hours_windows : [], updated_at: new Date().toISOString(),
      };
      const rows = await rest("bot_working_settings?setting_key=eq.default", { method: "PATCH", body: payload });
      res.json({ ok: true, data: rows?.[0] || rows });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });
  app.get("/bot-control-client.js", (_req, res) => res.type("application/javascript").send(fs.readFileSync(new URL("./bot-control-client.js", import.meta.url), "utf8")));
  app.get("/bot-control", (_req, res) => res.type("html").send(fs.readFileSync(new URL("./bot-control.html", import.meta.url), "utf8")));
}