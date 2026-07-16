import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const fetchAnchor = "async function fetchPancake(limit = 500, force = false) {";
if (!source.includes(fetchAnchor)) throw new Error("V7_PRODUCT_FETCH_ANCHOR_NOT_FOUND");

const helper = String.raw`
async function enrichPancakeProducts(rows = []) {
  const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
  const url = String(process.env.SUPABASE_URL || "https://ezygfpeeqbbirdeazene.supabase.co").replace(/\/$/, "");
  const ids = [...new Set((rows || []).map(row => String(row.conversation_id || "")).filter(Boolean))];
  if (!publicKey || !ids.length) return rows;
  try {
    const response = await fetch(url + "/rest/v1/rpc/v8_product_map_for_conversations", {
      method: "POST",
      headers: { apikey: publicKey, authorization: "Bearer " + publicKey, "content-type": "application/json" },
      body: JSON.stringify({ p_conversation_ids: ids }),
      signal: AbortSignal.timeout(30000),
      cache: "no-store"
    });
    if (!response.ok) return rows;
    const data = await response.json();
    const map = new Map((Array.isArray(data) ? data : []).map(item => [String(item.conversation_id), item]));
    return rows.map(row => {
      const detected = map.get(String(row.conversation_id || ""));
      return detected?.group_name ? { ...row, product: detected.group_name, product_key: detected.group_key, product_source: "conversation_history" } : row;
    });
  } catch { return rows; }
}
`;
source = source.replace(fetchAnchor, helper + "\n" + fetchAnchor);
const oldLine = "try { result.rows = (await pancakeFetchConversations(limit)).map(pancakeBuildCustomerRow); }";
const newLine = "try { const baseRows = (await pancakeFetchConversations(limit)).map(pancakeBuildCustomerRow); result.rows = await enrichPancakeProducts(baseRows); }";
if (!source.includes(oldLine)) throw new Error("V7_PRODUCT_ROWS_ANCHOR_NOT_FOUND");
source = source.replace(oldLine, newLine);
fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] V7 lead products enriched from full conversation history");