import fs from "node:fs";

const file = "meta-facebook-login.js";
let source = fs.readFileSync(file, "utf8");
const baseScopes = '"ads_read,business_management,pages_show_list,pages_read_engagement"';
const invalidScopes = '"ads_read,business_management,pages_show_list,pages_read_engagement,pages_messaging,pages_manage_metadata,pages_read_user_content"';
const validScopes = '"ads_read,business_management,pages_show_list,pages_read_engagement,pages_messaging,pages_manage_metadata"';

if (source.includes(invalidScopes)) source = source.replace(invalidScopes, validScopes);
else if (source.includes(baseScopes)) source = source.replace(baseScopes, validScopes);
else if (!source.includes("pages_messaging")) throw new Error("META_PAGES_MESSAGING_SCOPE_ANCHOR_NOT_FOUND");

const filterNeedle = ".filter(Boolean);";
const filterReplacement = '.filter((value) => value && value !== "pages_read_user_content");';
if (source.includes(filterNeedle)) source = source.replace(filterNeedle, filterReplacement);

fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] Meta OAuth requests only valid Page and Messenger scopes");
