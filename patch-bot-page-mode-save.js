import fs from "node:fs";
import { spawnSync } from "node:child_process";

const serverFile = "bot-control-ui.js";
let server = fs.readFileSync(serverFile, "utf8");
const marker = "AIGUKA_PAGE_MODE_SAVE_V2";

if (!server.includes(marker)) {
  const oldRoute = `  app.post("/bot-control/api/page-mode", async (req, res) => {
    try {
      const body = req.body || {};
      const data = await rpc("v8_set_runtime_mode", { p_page_id: String(body.page_id || ""), p_target_mode: String(body.mode || "OBSERVE"), p_requested_by: "railway_bot_control" });
      res.json({ ok: true, data });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });`;
  const newRoute = `  // AIGUKA_PAGE_MODE_SAVE_V2
  // Lưu cấu hình mong muốn của từng Page độc lập với Final Gate.
  // Quyền gửi thực tế vẫn do global runtime, lịch, kill switch và capability policy quyết định.
  app.post("/bot-control/api/page-mode", async (req, res) => {
    try {
      const body = req.body || {};
      const pageId = String(body.page_id || "").trim();
      let mode = String(body.mode || "OBSERVE").trim().toUpperCase();
      if (mode === "LIVE") mode = "PRODUCTION";
      if (!pageId) throw new Error("THIEU_PAGE_ID");
      if (!["OFF", "OBSERVE", "TEST", "PRODUCTION"].includes(mode)) throw new Error("CHE_DO_PAGE_KHONG_HOP_LE");

      const currentRows = await rest("v8_pages?select=page_id,page_name,bot_mode&page_id=eq." + encodeURIComponent(pageId) + "&limit=1");
      const current = currentRows?.[0];
      if (!current) throw new Error("KHONG_TIM_THAY_PAGE");

      let gate = null;
      try {
        gate = await rpc("v8_runtime_transition_check", { p_page_id: pageId, p_target_mode: mode });
      } catch {}

      const savedRows = await rest("v8_pages?page_id=eq." + encodeURIComponent(pageId), {
        method: "PATCH",
        body: { bot_mode: mode, updated_at: new Date().toISOString() },
      });
      const saved = savedRows?.[0] || { ...current, bot_mode: mode };

      let policy = null;
      try {
        const rows = await rpc("v8_resolve_runtime_policy", { p_page_id: pageId });
        policy = Array.isArray(rows) ? rows[0] : rows;
      } catch {}

      const blockers = Array.isArray(gate?.blockers) ? gate.blockers : [];
      try {
        await rest("v8_admin_change_log", {
          method: "POST",
          body: {
            actor: "railway_bot_control",
            action: "save_page_mode_preference",
            asset_type: "page",
            asset_id: pageId,
            before_data: { bot_mode: current.bot_mode },
            after_data: {
              bot_mode: mode,
              actual_runtime_mode: policy?.runtime_mode || null,
              blockers,
            },
          },
        });
      } catch {}

      res.json({
        ok: true,
        data: {
          changed: String(current.bot_mode || "").toUpperCase() !== mode,
          saved: true,
          page_id: pageId,
          previous_page_mode: current.bot_mode || null,
          new_page_mode: saved.bot_mode || mode,
          actual_runtime_mode: policy?.runtime_mode || null,
          can_send_text: policy?.can_send_text === true,
          can_send_image: policy?.can_send_image === true,
          blockers,
        },
      });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });`;
  if (!server.includes(oldRoute)) throw new Error("PAGE_MODE_SERVER_ROUTE_ANCHOR_NOT_FOUND");
  server = server.replace(oldRoute, newRoute);
  fs.writeFileSync(serverFile, server, "utf8");
}

const clientFile = "bot-control-client.js";
let client = fs.readFileSync(clientFile, "utf8");
if (!client.includes(marker)) {
  const oldClient = `    if (result.data?.changed === false) throw new Error("Không chuyển được chế độ: " + JSON.stringify(result.data.blockers || result.data));
    await loadState();
    setStatus("Đã cập nhật chế độ Trang");`;
  const newClient = `    // AIGUKA_PAGE_MODE_SAVE_V2
    await loadState();
    const blockers = Array.isArray(result.data?.blockers) ? result.data.blockers : [];
    const actual = result.data?.actual_runtime_mode ? pageModeLabel(result.data.actual_runtime_mode) : "chưa xác định";
    setStatus(blockers.length
      ? "Đã lưu chế độ Trang. Chế độ thực tế hiện là " + actual + "; hệ thống còn " + blockers.length + " cảnh báo an toàn."
      : "Đã lưu và cập nhật chế độ Trang");`;
  if (!client.includes(oldClient)) throw new Error("PAGE_MODE_CLIENT_ANCHOR_NOT_FOUND");
  client = client.replace(oldClient, newClient);
  fs.writeFileSync(clientFile, client, "utf8");
}

for (const file of [serverFile, clientFile]) {
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`PAGE_MODE_SAVE_SYNTAX_${file}:${syntax.stderr || syntax.stdout}`);
}
console.log("[AIGUKA] Page mode preference can be saved while runtime safety policy remains enforced");
