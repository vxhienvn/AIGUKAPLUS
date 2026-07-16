import fs from "node:fs";

export function installBotControlUi(app, options) {
  const { supabaseUrl, serviceRoleKey, publishableKey } = options;
  const key = serviceRoleKey || publishableKey;
  const headers = () => ({
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "x-aiguka-railway-test": "enabled",
    "x-aiguka-admin-secret": "AIGUKA_RAILWAY_TEST_MODE",
  });
  async function rest(path, request = {}) {
    if (!key) throw new Error("MISSING_SUPABASE_SERVICE_ROLE_KEY");
    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      method: request.method || "GET",
      headers: { ...headers(), Prefer: "return=representation" },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(40000),
      cache: "no-store",
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    if (!response.ok) throw new Error(data?.message || data?.error || `REST_HTTP_${response.status}`);
    return data;
  }
  async function rpc(name, args = {}) {
    if (!key) throw new Error("MISSING_SUPABASE_SERVICE_ROLE_KEY");
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(40000),
      cache: "no-store",
    });
    const text = await response.text();
    let data;
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
        try {
          const rows = await rpc("v8_resolve_runtime_policy", { p_page_id: page.page_id });
          policy = Array.isArray(rows) ? rows[0] : rows;
        } catch {}
        enriched.push({ ...page, policy });
      }
      res.json({ ok: true, pages: enriched, settings: settings?.[0] || null, runtime: config?.[0] || null, capabilities: capabilities || [] });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
  app.get("/bot-control-client.js", (_req, res) => res.type("application/javascript").send(fs.readFileSync(new URL("./bot-control-client.js", import.meta.url), "utf8")));
  app.get("/bot-control", (_req, res) => res.type("html").send(fs.readFileSync(new URL("./bot-control.html", import.meta.url), "utf8")));
}