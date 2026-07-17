import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const start = source.indexOf("async function dailyPage(req,res) {");
const end = source.indexOf("async function leadsPage(req,res) {", start);
if (start < 0 || end < 0) throw new Error("V7_DAILY_STAFF_HISTORY_ANCHOR_NOT_FOUND");
const daily = source.slice(start, end);
if (!daily.includes("fetchPancake(500)")) throw new Error("V7_DAILY_STAFF_LIMIT_ANCHOR_NOT_FOUND");
source = source.slice(0, start) + daily.replace("fetchPancake(500)", "fetchPancake(3000)") + source.slice(end);
fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] Daily staff column uses up to 3000 cached Pancake conversations");
