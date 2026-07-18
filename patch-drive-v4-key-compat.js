import fs from "node:fs";

const file = "drive-slide-manager-v4.js";
let source = fs.readFileSync(file, "utf8");
if (source.includes("AIGUKA_GOOGLE_DRIVE_OAUTH_V2")) {
  source = source.replaceAll("AIGUKA_GOOGLE_DRIVE_OAUTH_V2", "AIGUKA_GOOGLE_DRIVE_OAUTH_V1");
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA] Drive V4 uses existing encrypted Google connection");
} else if (source.includes("AIGUKA_GOOGLE_DRIVE_OAUTH_V1")) {
  console.log("[AIGUKA] Drive V4 key compatibility already active");
} else {
  throw new Error("DRIVE_V4_KEY_COMPAT_ANCHOR_NOT_FOUND");
}
