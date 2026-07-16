import fs from "node:fs";

export function installBotControlUi(app, options) {
  const { supabaseUrl, serviceRoleKey, publishableKey } = options;
  const key = serviceRoleKey || publishableKey;
  app.get("/bot-control-client.js", (_req, res) => res.type("application/javascript").send(fs.readFileSync(new URL("./bot-control-client.js", import.meta.url), "utf8")));
  app.get("/bot-control", (_req, res) => res.type("html").send(fs.readFileSync(new URL("./bot-control.html", import.meta.url), "utf8")));
}