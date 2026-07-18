import fs from "node:fs";

const file = "meta-facebook-login.js";
let source = fs.readFileSync(file, "utf8");
const oldScopes = '"ads_read,business_management,pages_show_list,pages_read_engagement"';
const newScopes = '"ads_read,business_management,pages_show_list,pages_read_engagement,pages_messaging,pages_manage_metadata,pages_read_user_content"';
if (source.includes(oldScopes)) {
  source = source.replace(oldScopes, newScopes);
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA] Meta OAuth now requests pages_messaging");
} else if (source.includes("pages_messaging")) {
  console.log("[AIGUKA] Meta OAuth pages_messaging scope already present");
} else {
  throw new Error("META_PAGES_MESSAGING_SCOPE_ANCHOR_NOT_FOUND");
}
