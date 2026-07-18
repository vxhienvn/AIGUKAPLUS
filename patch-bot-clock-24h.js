import fs from "node:fs";
import { spawnSync } from "node:child_process";

const clientFile = "bot-control-client.js";
const htmlFile = "bot-control.html";
const marker = "AIGUKA_BOT_CLOCK_24H_V1";

let client = fs.readFileSync(clientFile, "utf8");
let html = fs.readFileSync(htmlFile, "utf8");

if (client.includes(marker) && html.includes(marker)) {
  console.log("[AIGUKA] BOT schedule already uses explicit 24-hour clock");
} else {
  const replaceRequired = (source, needle, replacement, label) => {
    if (!source.includes(needle)) throw new Error(`BOT_CLOCK_24H_ANCHOR_NOT_FOUND:${label}`);
    return source.replace(needle, replacement);
  };

  client = replaceRequired(
    client,
    "function refreshWindow(row) {",
    `// ${marker}\nfunction normalizeClock24(value) {\n  const raw = String(value || \"\").trim().replace(/[.hH]/g, \":\").replace(/\\s+/g, \"\");\n  const compact = raw.match(/^(\\d{1,2})(?::?(\\d{2}))?$/);\n  if (!compact) return raw;\n  const hour = Number(compact[1]);\n  const minute = Number(compact[2] || 0);\n  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return raw;\n  return String(hour).padStart(2, \"0\") + \":\" + String(minute).padStart(2, \"0\");\n}\n\nfunction isValidClock24(value) {\n  return /^(?:[01]\\d|2[0-3]):[0-5]\\d$/.test(String(value || \"\"));\n}\n\nfunction refreshWindow(row) {`,
    "clock_helpers",
  );

  client = replaceRequired(
    client,
    `    + '<div><label>Bắt đầu</label><input class="w-start" type="time" value="' + escapeHtml(String(window.start || "08:00").slice(0, 5)) + '"></div>'\n    + '<div><label>Kết thúc</label><input class="w-end" type="time" value="' + escapeHtml(String(window.end || "12:00").slice(0, 5)) + '"></div>'`,
    `    + '<div><label>Bắt đầu (24h)</label><input class="w-start clock-24h" type="text" inputmode="numeric" maxlength="5" pattern="(?:[01]\\d|2[0-3]):[0-5]\\d" placeholder="08:00" value="' + escapeHtml(normalizeClock24(String(window.start || "08:00").slice(0, 5))) + '"></div>'\n    + '<div><label>Kết thúc (24h)</label><input class="w-end clock-24h" type="text" inputmode="numeric" maxlength="5" pattern="(?:[01]\\d|2[0-3]):[0-5]\\d" placeholder="23:59" value="' + escapeHtml(normalizeClock24(String(window.end || "12:00").slice(0, 5))) + '"></div>'`,
    "time_inputs",
  );

  client = replaceRequired(
    client,
    `  byId("schedule-windows").innerHTML = '<div class="schedule-head"><span>Tên khoảng</span><span>Bắt đầu</span><span>Kết thúc</span><span>Chế độ BOT</span><span>Chờ hỗ trợ</span><span>Hoạt động</span><span></span></div>'`,
    `  byId("schedule-windows").innerHTML = '<div class="schedule-head"><span>Tên khoảng</span><span>Bắt đầu (24h)</span><span>Kết thúc (24h)</span><span>Chế độ BOT</span><span>Chờ hỗ trợ</span><span>Hoạt động</span><span></span></div>'`,
    "schedule_header",
  );

  client = client.replace(
    `    end: "12:00",`,
    `    end: "23:59",`,
  );

  client = replaceRequired(
    client,
    `      start: row.querySelector(".w-start").value,\n      end: row.querySelector(".w-end").value,`,
    `      start: normalizeClock24(row.querySelector(".w-start").value),\n      end: normalizeClock24(row.querySelector(".w-end").value),`,
    "collect_times",
  );

  client = replaceRequired(
    client,
    `    if (windows.some((window) => !window.start || !window.end)) throw new Error("Mỗi khoảng phải có giờ bắt đầu và kết thúc");`,
    `    if (windows.some((window) => !window.start || !window.end)) throw new Error("Mỗi khoảng phải có giờ bắt đầu và kết thúc");\n    if (windows.some((window) => !isValidClock24(window.start) || !isValidClock24(window.end))) {\n      throw new Error("Giờ phải theo định dạng 24 giờ HH:MM, từ 00:00 đến 23:59");\n    }`,
    "save_validation",
  );

  client = replaceRequired(
    client,
    `document.addEventListener("change", (event) => {\n  if (event.target.matches(".w-mode")) refreshWindow(event.target.closest(".schedule-window"));`,
    `document.addEventListener("change", (event) => {\n  if (event.target.matches(".clock-24h")) {\n    const normalized = normalizeClock24(event.target.value);\n    if (isValidClock24(normalized)) event.target.value = normalized;\n  }\n  if (event.target.matches(".w-mode")) refreshWindow(event.target.closest(".schedule-window"));`,
    "change_normalizer",
  );

  client = replaceRequired(
    client,
    `document.addEventListener("click", (event) => {`,
    `document.addEventListener("focusout", (event) => {\n  if (!event.target.matches(".clock-24h")) return;\n  const normalized = normalizeClock24(event.target.value);\n  event.target.value = normalized;\n  event.target.setCustomValidity(isValidClock24(normalized) ? \"\" : \"Nhập giờ 24h dạng HH:MM, ví dụ 08:00 hoặc 23:59\");\n});\n\ndocument.addEventListener("click", (event) => {`,
    "blur_validation",
  );

  html = replaceRequired(
    html,
    `<h3>Lịch làm việc nhiều khung giờ</h3>\n      <div id="schedule-windows"></div>`,
    `<h3>Lịch làm việc nhiều khung giờ</h3>\n      <div class="clock-note"><b>Giờ 24h:</b> nhập từ 00:00 đến 23:59. Muốn BOT chạy đến hết ngày, đặt giờ kết thúc là <b>23:59</b>.</div>\n      <div id="schedule-windows"></div>`,
    "clock_note",
  );

  html = replaceRequired(
    html,
    `.schedule-window button{height:34px;padding:5px 8px}.intro-layout`,
    `.schedule-window button{height:34px;padding:5px 8px}.clock-note{padding:9px 11px;margin:0 0 10px;border:1px solid #9fc4ef;background:#eef6ff;border-radius:8px;color:#294766}.clock-24h{font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:700;letter-spacing:.3px}.clock-24h:invalid{border-color:#dc2626;background:#fff7f7}.intro-layout`,
    "clock_styles",
  );

  html = html.replace("</body>", `<!-- ${marker} --></body>`);

  fs.writeFileSync(clientFile, client, "utf8");
  fs.writeFileSync(htmlFile, html, "utf8");

  const syntax = spawnSync(process.execPath, ["--check", clientFile], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`BOT_CLOCK_24H_CLIENT_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] BOT schedule now uses explicit 24-hour HH:MM inputs");
}
