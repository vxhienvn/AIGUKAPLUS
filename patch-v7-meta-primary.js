import fs from "node:fs";
const file="v7-dashboard-stable.js";
let source=fs.readFileSync(file,"utf8");
source=source.replace('import { createRequire } from "node:module";','import { createRequire } from "node:module";\nimport { fetchMetaBusinessRows } from "./meta-business-leads.js";');
const old=`async function fetchPancake(limit = 500, force = false) {
  const key = String(limit); const hit = cache.pancake.get(key);
  if (!force && hit && Date.now() - hit.time < 3 * 60 * 1000) return hit.data;
  const result = { rows: [], error: null };
  try { result.rows = (await pancakeFetchConversations(limit)).map(pancakeBuildCustomerRow); }
  catch (e) { result.error = e.message; }
  cache.pancake.set(key, { time: Date.now(), data: result }); return result;
}`;
const replacement=`async function fetchPancake(limit = 500, force = false) {
  const key = "meta-primary:"+String(limit); const hit = cache.pancake.get(key);
  if (!force && hit && Date.now() - hit.time < 3 * 60 * 1000) return hit.data;
  const result = { rows: [], error: null, primary_source: "meta_business", pancake_role: "tags_only" };
  try {
    const [metaRows,pancakeRaw]=await Promise.all([fetchMetaBusinessRows(Math.max(limit*4,2000)),pancakeFetchConversations(limit).catch(()=>[])]);
    const pancakeRows=pancakeRaw.map(pancakeBuildCustomerRow);
    const byCustomer=new Map(),byName=new Map();
    for(const p of pancakeRows){if(p.customer_id)byCustomer.set(String(p.customer_id),p);if(p.name)byName.set(String(p.name).trim().toLowerCase(),p)}
    result.rows=metaRows.map(m=>{
      const p=byCustomer.get(String(m.customer_id||""))||byName.get(String(m.name||"").trim().toLowerCase())||{};
      return {...p,...m,phones:p.phones||[],tags:p.tags||[],has_phone:Boolean(p.has_phone),has_zalo:Boolean(p.has_zalo),ad_ids:p.ad_ids||[],post_id:p.post_id||"",ad_name:p.ad_name||"",ad_account_id:p.ad_account_id||"",ad_account_name:p.ad_account_name||"",source_type:m.source_type,date_verified:true};
    });
  } catch (e) { result.error = e.message; }
  cache.pancake.set(key, { time: Date.now(), data: result }); return result;
}`;
if(!source.includes(old))throw Error("V7_FETCH_PANCAKE_ANCHOR_NOT_FOUND");
source=source.replace(old,replacement);
fs.writeFileSync(file,source,"utf8");
console.log("[AIGUKA] Meta Business is primary conversation source; Pancake enriches tags only");
