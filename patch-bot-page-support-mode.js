import fs from "node:fs";
import { spawnSync } from "node:child_process";

const marker = "AIGUKA_PAGE_SUPPORT_SLIDE_ONLY_V1";

const serverFile = "bot-control-ui.js";
let server = fs.readFileSync(serverFile, "utf8");
if (!server.includes(marker)) {
  const whitelistOld = 'if (!["OFF", "OBSERVE", "TEST", "PRODUCTION"].includes(mode)) throw new Error("CHE_DO_PAGE_KHONG_HOP_LE");';
  const whitelistNew = 'if (!["OFF", "OBSERVE", "TEST", "SUPPORT", "PRODUCTION"].includes(mode)) throw new Error("CHE_DO_PAGE_KHONG_HOP_LE"); // AIGUKA_PAGE_SUPPORT_SLIDE_ONLY_V1';
  if (!server.includes(whitelistOld)) throw new Error("PAGE_SUPPORT_SERVER_WHITELIST_ANCHOR_NOT_FOUND");
  server = server.replace(whitelistOld, whitelistNew);
  fs.writeFileSync(serverFile, server, "utf8");
}

const clientFile = "bot-control-client.js";
let client = fs.readFileSync(clientFile, "utf8");
if (!client.includes(marker)) {
  const labelsOld = '  TEST: "Chạy thử nghiệm",\n  PRODUCTION: "Hoạt động chính thức",';
  const labelsNew = '  TEST: "Chạy thử nghiệm",\n  SUPPORT: "Hỗ trợ Sale — slide ngay, chữ sau thời gian chờ",\n  PRODUCTION: "Hoạt động chính thức",';
  if (!client.includes(labelsOld)) throw new Error("PAGE_SUPPORT_CLIENT_LABEL_ANCHOR_NOT_FOUND");
  client = client.replace(labelsOld, labelsNew);

  const optionsOld = '<option value="TEST" ' + "' + (current === \"TEST\" ? \"selected\" : \"\") + '" + '>Chạy thử nghiệm</option><option value="PRODUCTION" ';
  const optionsNew = '<option value="TEST" ' + "' + (current === \"TEST\" ? \"selected\" : \"\") + '" + '>Chạy thử nghiệm</option><option value="SUPPORT" ' + "' + (current === \"SUPPORT\" ? \"selected\" : \"\") + '" + '>Hỗ trợ Sale — slide ngay, chữ sau thời gian chờ</option><option value="PRODUCTION" ';
  if (!client.includes(optionsOld)) throw new Error("PAGE_SUPPORT_CLIENT_OPTIONS_ANCHOR_NOT_FOUND");
  client = client.replace(optionsOld, optionsNew);

  const statusOld = 'setStatus("Đã cập nhật chế độ Trang");';
  if (client.includes(statusOld)) {
    client = client.replace(statusOld, 'setStatus(mode === "SUPPORT" ? "Đã lưu Hỗ trợ Sale: gửi slide khi khách xin mẫu; trả lời chữ sau thời gian chờ nếu Sale chưa phản hồi." : "Đã cập nhật chế độ Trang");');
  }

  const patchedStatusOld = 'setStatus(blockers.length\n      ? "Đã lưu chế độ Trang. Chế độ thực tế hiện là " + actual + "; hệ thống còn " + blockers.length + " cảnh báo an toàn."\n      : "Đã lưu và cập nhật chế độ Trang");';
  const patchedStatusNew = 'setStatus(blockers.length\n      ? "Đã lưu chế độ Trang. Chế độ thực tế hiện là " + actual + "; hệ thống còn " + blockers.length + " cảnh báo an toàn."\n      : (mode === "SUPPORT" ? "Đã lưu Hỗ trợ Sale: slide theo yêu cầu, chữ tiếp quản sau thời gian chờ." : "Đã lưu và cập nhật chế độ Trang"));';
  if (client.includes(patchedStatusOld)) client = client.replace(patchedStatusOld, patchedStatusNew);

  client = client.replace("loadState();", "// AIGUKA_PAGE_SUPPORT_SLIDE_ONLY_V1\nloadState();");
  fs.writeFileSync(clientFile, client, "utf8");
}

for (const file of [serverFile, clientFile]) {
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`PAGE_SUPPORT_SYNTAX_${file}:${syntax.stderr || syntax.stdout}`);
}

console.log("[AIGUKA] Per-Page SUPPORT mode installed: slide on request, text takeover after configured Sale wait");