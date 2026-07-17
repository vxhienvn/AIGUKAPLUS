let state = null;

const PAGE_MODE_LABELS = {
  OFF: "Tắt hoàn toàn",
  OBSERVE: "Chỉ quan sát",
  TEST: "Chạy thử nghiệm",
  PRODUCTION: "Hoạt động chính thức",
  LIVE: "Hoạt động chính thức",
};

const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(
  /[&<>"']/g,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
);
const pageModeLabel = (value) => PAGE_MODE_LABELS[String(value || "OBSERVE").toUpperCase()] || String(value || "Chỉ quan sát");

function setStatus(text, ok = true) {
  byId("status").textContent = text;
  byId("status").className = "status" + (ok ? "" : " bad");
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text || "Phản hồi không hợp lệ" }; }
  if (!response.ok || json.ok === false) throw new Error(json.error || json.message || `HTTP ${response.status}`);
  return json;
}

function normalizeScheduleMode(value) {
  const mode = String(value || "off").toLowerCase();
  if (["support", "assist", "sale_support"].includes(mode)) return "support";
  if (["on", "full", "production", "auto", "followup", "follow_up", "care"].includes(mode)) return "on";
  return "off";
}

function scheduleModeHelp(mode) {
  if (mode === "on") return "BOT chạy các chức năng được Admin bật.";
  if (mode === "support") return "Ưu tiên Sale; BOT hỗ trợ sau thời gian chờ.";
  return "BOT tắt hoàn toàn trong khung giờ này.";
}

function refreshWindow(row) {
  const mode = row.querySelector(".w-mode").value;
  const delay = row.querySelector(".w-delay");
  row.querySelector(".mode-help").textContent = scheduleModeHelp(mode);
  delay.disabled = mode !== "support";
  if (mode !== "support") delay.value = 0;
  else if (!Number(delay.value)) delay.value = 5;
}

function windowHtml(window = {}) {
  const mode = normalizeScheduleMode(window.mode);
  const waitMinutes = mode === "support" ? Number(window.wait_minutes ?? window.delay_minutes ?? 5) : 0;
  return '<div class="schedule-window">'
    + '<div><label>Tên khoảng</label><input class="w-label" value="' + escapeHtml(window.label || window.name || "Khung giờ mới") + '"></div>'
    + '<div><label>Bắt đầu</label><input class="w-start" type="time" value="' + escapeHtml(String(window.start || "08:00").slice(0, 5)) + '"></div>'
    + '<div><label>Kết thúc</label><input class="w-end" type="time" value="' + escapeHtml(String(window.end || "12:00").slice(0, 5)) + '"></div>'
    + '<div><label>Chế độ BOT</label><select class="w-mode">'
    + '<option value="on" ' + (mode === "on" ? "selected" : "") + '>ON — Bật BOT</option>'
    + '<option value="support" ' + (mode === "support" ? "selected" : "") + '>Hỗ trợ Sale</option>'
    + '<option value="off" ' + (mode === "off" ? "selected" : "") + '>OFF — Tắt BOT</option>'
    + '</select><div class="mode-help">' + scheduleModeHelp(mode) + '</div></div>'
    + '<div><label>Chờ hỗ trợ (phút)</label><input class="w-delay" type="number" min="0" value="' + waitMinutes + '" ' + (mode !== "support" ? "disabled" : "") + '></div>'
    + '<div><label>Hoạt động</label><input class="w-enabled" type="checkbox" ' + (window.enabled !== false ? "checked" : "") + '></div>'
    + '<button type="button" class="remove-window">Xóa</button></div>';
}

function renderWindows(rows) {
  byId("schedule-windows").innerHTML = '<div class="schedule-head"><span>Tên khoảng</span><span>Bắt đầu</span><span>Kết thúc</span><span>Chế độ BOT</span><span>Chờ hỗ trợ</span><span>Hoạt động</span><span></span></div>'
    + (rows || []).map(windowHtml).join("");
}

function addWindow() {
  byId("schedule-windows").insertAdjacentHTML("beforeend", windowHtml({
    label: "Khung giờ mới",
    start: "08:00",
    end: "12:00",
    mode: "support",
    enabled: true,
    wait_minutes: 5,
  }));
}

function collectWindows() {
  return [...document.querySelectorAll(".schedule-window")].map((row) => {
    const label = row.querySelector(".w-label").value.trim() || "Không tên";
    const mode = row.querySelector(".w-mode").value;
    return {
      label,
      name: label,
      start: row.querySelector(".w-start").value,
      end: row.querySelector(".w-end").value,
      mode,
      enabled: row.querySelector(".w-enabled").checked,
      wait_minutes: mode === "support" ? Math.max(0, Number(row.querySelector(".w-delay").value || 5)) : 0,
      delay_minutes: mode === "support" ? Math.max(0, Number(row.querySelector(".w-delay").value || 5)) : 0,
    };
  });
}

function readFeatures() {
  return {
    text_enabled: byId("feature-text").checked,
    slide_enabled: byId("feature-slide").checked,
    care_enabled: byId("feature-care").checked,
  };
}

function featureNames(features) {
  const names = [];
  if (features.text_enabled) names.push("trả lời tư vấn bằng chữ");
  if (features.slide_enabled) names.push("gửi slide/hình ảnh");
  if (features.care_enabled) names.push("chăm sóc lại khách");
  return names;
}

function updateFeatureGuide() {
  const features = readFeatures();
  const names = featureNames(features);
  byId("guide-on").textContent = names.length
    ? "BOT được dùng: " + names.join(", ") + "."
    : "Chưa có chức năng nào được Admin bật; BOT không gửi nội dung.";
  const supportParts = ["ưu tiên nhân viên Sale"];
  if (features.slide_enabled) supportParts.push("gửi slide khi nhận diện đúng nhu cầu");
  if (features.text_enabled) supportParts.push("hỗ trợ trả lời sau thời gian chờ");
  byId("guide-support").textContent = supportParts.join("; ") + ".";
}

function renderFeatures() {
  const settings = state.settings || {};
  const runtime = state.runtime?.value || {};
  const config = settings.support_config || {};
  byId("feature-text").checked = Boolean(config.text_enabled ?? runtime.aiguka_can_send_text ?? false);
  byId("feature-slide").checked = Boolean(config.slide_enabled ?? runtime.aiguka_can_send_image ?? false);
  byId("feature-care").checked = Boolean(config.care_enabled ?? runtime.care_enabled ?? false);
  updateFeatureGuide();
}

function renderPages() {
  byId("pages").innerHTML = (state.pages || []).map((page) => {
    const current = String(page.bot_mode || "OBSERVE").toUpperCase();
    return '<div class="page"><div class="page-head"><div><b>' + escapeHtml(page.page_name) + '</b><br><small>' + escapeHtml(page.page_id) + '</small><br><span>Thực tế: <b>' + escapeHtml(pageModeLabel(page.policy?.runtime_mode || current)) + '</b></span></div>'
      + '<div><select id="mode-' + escapeHtml(page.page_id) + '"><option value="OFF" ' + (current === "OFF" ? "selected" : "") + '>Tắt hoàn toàn</option><option value="OBSERVE" ' + (current === "OBSERVE" ? "selected" : "") + '>Chỉ quan sát</option><option value="TEST" ' + (current === "TEST" ? "selected" : "") + '>Chạy thử nghiệm</option><option value="PRODUCTION" ' + (["PRODUCTION", "LIVE"].includes(current) ? "selected" : "") + '>Hoạt động chính thức</option></select> <button type="button" data-save-page="' + escapeHtml(page.page_id) + '">Lưu chế độ</button></div></div>'
      + '<div class="safe" style="margin-top:8px">Gửi chữ: ' + (page.policy?.can_send_text ? "Có" : "Không") + ' · Gửi slide: ' + (page.policy?.can_send_image ? "Có" : "Không") + ' · Kết nối nhận tin: ' + escapeHtml(page.webhook_status || "chưa rõ") + '</div></div>';
  }).join("") || "<div>Chưa có Trang.</div>";
}

function renderPolicy() {
  const rows = (state.pages || []).map((page) => (
    escapeHtml(page.page_name) + ": " + escapeHtml(pageModeLabel(page.policy?.runtime_mode || page.bot_mode))
    + " — chữ " + (page.policy?.can_send_text ? "BẬT" : "TẮT")
    + ", slide " + (page.policy?.can_send_image ? "BẬT" : "TẮT")
  ));
  byId("policy").innerHTML = rows.join("<br>") || "Chưa có dữ liệu.";
}

async function loadState() {
  setStatus("Đang tải điều khiển BOT…");
  try {
    state = await api("/bot-control/api/state");
    const settings = state.settings || {};
    const rows = settings.reply_windows?.length ? settings.reply_windows : [
      { label: "Giờ làm việc", start: String(settings.work_start || "08:00").slice(0, 5), end: String(settings.work_end || "22:00").slice(0, 5), mode: "support", enabled: true, wait_minutes: Number(settings.support_wait_minutes || 5) },
      { label: "Ngoài giờ", start: String(settings.work_end || "22:00").slice(0, 5), end: String(settings.work_start || "08:00").slice(0, 5), mode: "off", enabled: true },
    ];
    renderWindows(rows);
    byId("staff-count").value = settings.staff_online_count ?? 0;
    byId("holiday").value = String(Boolean(settings.holiday_mode));
    byId("schedule-open").value = String(settings.is_open !== false);
    renderFeatures();
    renderPages();
    renderPolicy();
    setStatus("Đã tải trạng thái BOT");
  } catch (error) {
    setStatus(error.message, false);
  }
}

async function saveFeatures() {
  setStatus("Đang lưu chức năng BOT…");
  try {
    await api("/bot-control/api/features", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(readFeatures()),
    });
    await loadState();
    setStatus("Đã lưu cài đặt chức năng BOT");
  } catch (error) {
    setStatus(error.message, false);
  }
}

async function savePageMode(pageId) {
  const mode = byId("mode-" + pageId).value;
  if (mode === "PRODUCTION" && !confirm("Bật Hoạt động chính thức cho Trang này?")) return;
  setStatus("Đang đổi chế độ Trang…");
  try {
    const result = await api("/bot-control/api/page-mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page_id: pageId, mode }),
    });
    if (result.data?.changed === false) throw new Error("Không chuyển được chế độ: " + JSON.stringify(result.data.blockers || result.data));
    await loadState();
    setStatus("Đã cập nhật chế độ Trang");
  } catch (error) {
    setStatus(error.message, false);
  }
}

async function saveSchedule() {
  setStatus("Đang lưu toàn bộ lịch…");
  try {
    const old = state.settings || {};
    const windows = collectWindows();
    if (!windows.length) throw new Error("Cần ít nhất một khoảng thời gian");
    if (windows.some((window) => !window.start || !window.end)) throw new Error("Mỗi khoảng phải có giờ bắt đầu và kết thúc");
    const active = windows.filter((window) => window.enabled && window.mode !== "off");
    const supportWaits = windows.filter((window) => window.enabled && window.mode === "support").map((window) => window.wait_minutes || 5);
    await api("/bot-control/api/schedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        timezone: old.timezone || "Asia/Ho_Chi_Minh",
        work_start: windows[0].start,
        work_end: windows[windows.length - 1].end,
        is_open: byId("schedule-open").value === "true",
        holiday_mode: byId("holiday").value === "true",
        staff_online_count: Number(byId("staff-count").value || 0),
        working_wait_minutes: supportWaits.length ? Math.min(...supportWaits) : 5,
        support_wait_minutes: supportWaits.length ? Math.min(...supportWaits) : 5,
        outside_wait_minutes: old.outside_wait_minutes || 5,
        admin_pause_minutes: old.admin_pause_minutes || 10,
        customer_wait_minutes: old.customer_wait_minutes || 5,
        reply_windows: windows,
        working_windows: active,
        after_hours_windows: windows.filter((window) => window.mode === "off"),
        bot_mode: "scheduled_sale",
      }),
    });
    await loadState();
    setStatus("Đã lưu " + windows.length + " khoảng thời gian; chức năng Admin không bị thay đổi");
  } catch (error) {
    setStatus(error.message, false);
  }
}

document.addEventListener("change", (event) => {
  if (event.target.matches(".w-mode")) refreshWindow(event.target.closest(".schedule-window"));
  if (event.target.matches("#feature-text,#feature-slide,#feature-care")) updateFeatureGuide();
});

document.addEventListener("click", (event) => {
  const removeButton = event.target.closest(".remove-window");
  if (removeButton) removeButton.closest(".schedule-window").remove();
  const pageButton = event.target.closest("[data-save-page]");
  if (pageButton) savePageMode(pageButton.dataset.savePage);
});

byId("add-window").addEventListener("click", addWindow);
byId("save-schedule").addEventListener("click", saveSchedule);
byId("save-features").addEventListener("click", saveFeatures);
loadState();
