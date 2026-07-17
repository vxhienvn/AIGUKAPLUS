import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");

const start = source.indexOf("async function fetchMetaFirstCustomerStarts(since,until){");
const end = source.indexOf("\n\nasync function dailyPage(req,res)", start);
if (start < 0 || end < 0) {
  throw new Error("V7_DAILY_SELF_CONTAINED_ANCHOR_NOT_FOUND");
}

let fn = source.slice(start, end);
if (!fn.includes("AIGUKA_DAILY_SELF_CONTAINED_SUPABASE_V1")) {
  fn = fn.replace(
    "async function fetchMetaFirstCustomerStarts(since,until){",
    `async function fetchMetaFirstCustomerStarts(since,until){
  // AIGUKA_DAILY_SELF_CONTAINED_SUPABASE_V1
  const dailySupabaseUrl=String(process.env.SUPABASE_URL||"https://ezygfpeeqbbirdeazene.supabase.co").replace(/\\/$/,"");
  const dailySupabaseKey=process.env.SUPABASE_SERVICE_ROLE_KEY||"";`,
  );
}

fn = fn
  .replaceAll("META_LEADS_SUPABASE_URL", "dailySupabaseUrl")
  .replaceAll("META_LEADS_SUPABASE_KEY", "dailySupabaseKey");

if (fn.includes("META_LEADS_SUPABASE_")) {
  throw new Error("V7_DAILY_SELF_CONTAINED_REPLACEMENT_FAILED");
}

source = source.slice(0, start) + fn + source.slice(end);
fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] Daily Meta-new-customer loader now uses self-contained Supabase config");
