import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const fetchAnchor = "async function fetchPancake(limit = 500, force = false) {";
if (!source.includes(fetchAnchor)) throw new Error("V7_PRODUCT_FETCH_ANCHOR_NOT_FOUND");

const helper = String.raw`

async function fetchMetaLeadFallback(limit = 5000) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
  const url = String(process.env.SUPABASE_URL || "https://ezygfpeeqbbirdeazene.supabase.co").replace(/\/$/, "");
  if (!key) return [];
  const headers = { apikey:key, authorization:"Bearer "+key };
  const read = async path => {
    const response = await fetch(url+"/rest/v1/"+path,{headers,signal:AbortSignal.timeout(40000),cache:"no-store"});
    if(!response.ok) throw new Error("META_FALLBACK_HTTP_"+response.status);
    return response.json();
  };
  const [customers,messages] = await Promise.all([
    read("v8_customers?select=id,page_id,sender_id,display_name,phone,zalo,tags,last_product_key,last_seen_at,assigned_sale,raw_profile&limit=2000"),
    read("v8_messages_raw?select=customer_id,page_id,conversation_id,direction,actor_type,actor_name,message_text,attachments,raw_payload,source_detail,sent_at,is_automatic&order=sent_at.desc&limit="+Math.max(1000,Number(limit)||5000))
  ]);
  const byCustomer=new Map(), customerMap=new Map((customers||[]).map(x=>[String(x.id),x]));
  const findValue=(value,names)=>{
    if(!value||typeof value!=="object")return "";
    for(const [k,v] of Object.entries(value)){
      if(names.includes(String(k).toLowerCase())&&v!=null&&typeof v!=="object")return String(v);
      const nested=findValue(v,names);if(nested)return nested;
    }
    return "";
  };
  for(const m of messages||[]){
    const id=String(m.customer_id||"");if(!id)continue;
    const x=byCustomer.get(id)||{customer_id:id,page_id:m.page_id||"",conversation_id:m.conversation_id||"",staff:new Set(),ad_ids:new Set(),post_id:"",history:[],last_customer_message_at:"",snippet:""};
    const direction=String(m.direction||"").toLowerCase(),actor=String(m.actor_type||"").toLowerCase();
    const inbound=direction==="inbound"||direction==="incoming"||actor==="customer";
    if(inbound&&!x.last_customer_message_at){x.last_customer_message_at=m.sent_at;x.snippet=m.message_text||((m.attachments&&JSON.stringify(m.attachments)!=="[]")?"[Attachment]":"");}
    if(!inbound&&!m.is_automatic&&m.actor_name&& !/bot|aiguka|aicake|pancake|page/i.test(String(m.actor_name)))x.staff.add(String(m.actor_name).trim());
    const raw={raw_payload:m.raw_payload,source_detail:m.source_detail};
    const ad=findValue(raw,["ad_id","adid"]);if(ad)x.ad_ids.add(ad);
    const post=findValue(raw,["post_id","postid"]);if(post&&!x.post_id)x.post_id=post;
    if(m.message_text)x.history.push(m.message_text);
    byCustomer.set(id,x);
  }
  return [...byCustomer.values()].map(x=>{
    const p=customerMap.get(x.customer_id)||{},phones=[p.phone,p.zalo].filter(Boolean);
    return {...x,name:p.display_name||p.sender_id||("Khách "+x.customer_id.slice(-6)),phones,has_phone:Boolean(p.phone),has_zalo:Boolean(p.zalo),tags:[...(p.tags||[]),...x.staff],product:p.last_product_key||"Khác",updated_at:x.last_customer_message_at||p.last_seen_at,ad_ids:[...x.ad_ids],source_type:"Tin nhắn",last_message_is_customer:true,conversation_history:x.history.join("\n"),meta_fallback:true};
  }).filter(x=>x.last_customer_message_at);
}

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
const newLine = "try { let baseRows=[]; try { baseRows=(await pancakeFetchConversations(limit)).map(pancakeBuildCustomerRow); } catch(error) { result.error='Pancake: '+error.message; } if(!baseRows.length) { baseRows=await fetchMetaLeadFallback(Math.max(5000,limit)); result.source='meta_supabase'; } result.rows = await enrichPancakeProducts(baseRows); }";
if (!source.includes(oldLine)) throw new Error("V7_PRODUCT_ROWS_ANCHOR_NOT_FOUND");
source = source.replace(oldLine, newLine);
fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] V7 lead products enriched from full conversation history");
