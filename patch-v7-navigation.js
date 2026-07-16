import fs from "node:fs";
const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
source = source.replaceAll("⚙ Quản lý Page/TEST", "⚙ Điều khiển BOT & Lịch");
source = source.replaceAll("AI Học có kiểm duyệt", "AI Học & Quản lý Prompt");
fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] Dashboard navigation names updated for BOT and Prompt management");