import fs from "node:fs";
const file="v7-dashboard-stable.js";
let source=fs.readFileSync(file,"utf8");

source=source.replaceAll("fields=id,name,account_status&limit=", "fields=id,name,account_status,timezone_name,timezone_offset_hours_utc&limit=");
source=source.replaceAll("&limit=500&access_token=${token}", "&action_attribution_windows=%5B%227d_click%22%5D&action_report_time=conversion&limit=500&access_token=${token}");

const adsDataAnchor='      const data = await pages(url, 20);\n      for (const x of data) {';
const adsDataReplacement=`      const data = await pages(url, 20);
      const creativePostByAd = new Map();
      const insightAdIds = [...new Set(data.map(x=>String(x.ad_id||"")).filter(Boolean))];
      for(let i=0;i<insightAdIds.length;i+=50){
        const ids=insightAdIds.slice(i,i+50).join(",");
        const creativeUrl=\`https://graph.facebook.com/\${GRAPH_VERSION}/?ids=\${encodeURIComponent(ids)}&fields=creative%7Beffective_object_story_id%7D&access_token=\${token}\`;
        const creativeData=await fetchJson(creativeUrl);
        for(const [adId,item] of Object.entries(creativeData||{})){
          const postId=item?.creative?.effective_object_story_id||"";
          if(postId) creativePostByAd.set(String(adId),String(postId));
        }
      }
      for (const x of data) {`;
if(!source.includes(adsDataAnchor)) throw new Error("V7_AD_CREATIVE_ANCHOR_NOT_FOUND");
source=source.replace(adsDataAnchor,adsDataReplacement);
source=source.replace(
  'clicks: Number(x.clicks || 0) });',
  'clicks: Number(x.clicks || 0), postId: creativePostByAd.get(String(x.ad_id||"")) || "" });'
);

const oldMapLeads=`function mapLeads(pancakeRows, adsRows, since, until) {
  const byAd = new Map(adsRows.map(x => [String(x.adId), x]));
  return pancakeRows.filter(x => { const d = dateKey(x.updated_at); return d && d >= since && d <= until; }).map(x => {
    const ids = (x.ad_ids || []).map(String); const ad = ids.map(id => byAd.get(id)).find(Boolean);
    return { ...x, accountId: ad?.accountId || x.ad_account_id || "", accountName: ad?.accountName || x.ad_account_name || "", adId: ad?.adId || ids[0] || "", adName: ad?.adName || x.ad_name || "", campaignName: ad?.campaignName || "", adsetName: ad?.adsetName || "" };
  });
}`;
const newMapLeads=`function mapLeads(pancakeRows, adsRows, since, until) {
  const byAd = new Map(adsRows.map(x => [String(x.adId), x]));
  const byPost = new Map();
  for(const ad of adsRows){
    const post=String(ad.postId||""); if(!post)continue;
    byPost.set(post,ad); byPost.set(post.split("_").pop(),ad);
  }
  const candidates=pancakeRows.filter(x => {
    const d=dateKey(x.last_customer_message_at||x.updated_at);
    return d&&d>=since&&d<=until&&(x.source_type==="Bình luận"||x.last_message_is_customer!==false);
  });
  const knownByCustomer=new Map(),knownByName=new Map();
  for(const x of candidates){
    const direct=(x.ad_ids||[]).map(String).map(id=>byAd.get(id)).find(Boolean);
    const post=String(x.post_id||"");
    const ad=direct||byPost.get(post)||byPost.get(post.split("_").pop());
    if(ad&&x.customer_id)knownByCustomer.set(String(x.customer_id),ad);
    if(ad&&x.name)knownByName.set(String(x.name).trim().toLowerCase(),ad);
  }
  const enriched=candidates.map(x => {
    const ids=(x.ad_ids||[]).map(String),post=String(x.post_id||"");
    const ad=ids.map(id=>byAd.get(id)).find(Boolean)||byPost.get(post)||byPost.get(post.split("_").pop())||knownByCustomer.get(String(x.customer_id||""))||knownByName.get(String(x.name||"").trim().toLowerCase());
    return { ...x, accountId: ad?.accountId || x.ad_account_id || "", accountName: ad?.accountName || x.ad_account_name || "", adId: ad?.adId || ids[0] || "", adName: ad?.adName || x.ad_name || "", campaignName: ad?.campaignName || "", adsetName: ad?.adsetName || "", attributionMethod: ids.length?"ad_id":(post&&ad?"post_id":(ad?"khách_quay_lại":"khách_vãng_lai")), dateVerified:Boolean(x.last_customer_message_at) };
  });
  const grouped=new Map();
  for(const x of enriched){
    const customerKey=String(x.customer_id||"").trim()||String(x.name||"").trim().toLowerCase();
    const adKey=String(x.adId||"").trim()||"VANG_LAI";
    const key=customerKey+"|"+adKey;
    const old=grouped.get(key);
    if(!old){grouped.set(key,{...x,customerKey,sourceTypes:new Set([x.source_type||"Tin nhắn"]),conversationIds:[x.conversation_id].filter(Boolean)});continue}
    old.sourceTypes.add(x.source_type||"Tin nhắn");
    old.source_type=[...old.sourceTypes].sort((a,b)=>a==="Bình luận"?-1:1).join(" + ");
    old.tags=[...new Set([...(old.tags||[]),...(x.tags||[])])];
    old.phones=[...new Set([...(old.phones||[]),...(x.phones||[])])];
    old.has_phone=old.has_phone||x.has_phone;old.has_zalo=old.has_zalo||x.has_zalo;
    old.conversationIds.push(x.conversation_id);
    if(new Date(x.last_customer_message_at||x.updated_at)>new Date(old.last_customer_message_at||old.updated_at)){old.snippet=x.snippet;old.updated_at=x.updated_at;old.last_customer_message_at=x.last_customer_message_at}
    old.dateVerified=old.dateVerified&&Boolean(x.last_customer_message_at);
  }
  const rows=[...grouped.values()].sort((a,b)=>a.customerKey.localeCompare(b.customerKey,"vi")||String(a.adId||"").localeCompare(String(b.adId||"")));
  let previous="";
  for(const row of rows){row.showCustomerName=row.customerKey!==previous;previous=row.customerKey;row.source_type=[...row.sourceTypes].sort((a,b)=>a==="Bình luận"?-1:1).join(" + ");row.conversation_id=row.conversationIds.join(", ")}
  return rows;
}`;
if(!source.includes(oldMapLeads)) throw new Error("V7_MAP_LEADS_ANCHOR_NOT_FOUND");
source=source.replace(oldMapLeads,newMapLeads);

source=source.replace(
  'map.set(id, { ...old, id, name: old.name && old.name !== id ? old.name : (x.name || x.account_name || id), status: x.account_status || x.status || old.status || "", source: old.source ? `${old.source}+${source}` : source });',
  'map.set(id, { ...old, id, name: old.name && old.name !== id ? old.name : (x.name || x.account_name || id), status: x.account_status || x.status || old.status || "", timezoneName: x.timezone_name || old.timezoneName || "Không xác định", timezoneOffset: x.timezone_offset_hours_utc ?? old.timezoneOffset ?? null, source: old.source ? `${old.source}+${source}` : source });'
);

const loopStart='for (const account of accounts) {\n    try {';
const loopCount=source.split(loopStart).length-1;
if(loopCount<2) throw new Error("V7_ACCOUNT_LOOPS_NOT_FOUND:"+loopCount);
source=source.replaceAll(loopStart,'await Promise.all(accounts.map(async account => {\n    try {');
const loopEnd='    } catch (e) { result.errors.push(`${account.name}: ${e.message}`); }\n  }\n  result.rows.sort';
const endCount=source.split(loopEnd).length-1;
if(endCount<2) throw new Error("V7_ACCOUNT_LOOP_ENDS_NOT_FOUND:"+endCount);
source=source.replaceAll(loopEnd,'    } catch (e) { result.errors.push(`${account.name}: ${e.message}`); }\n  }));\n  result.rows.sort');

source=source.replace(
  '<div class="card table"><table><thead><tr><th>#</th><th>Khách hàng</th>',
  '<div class="card table"><table data-meta-messages="${meta.totalMessages}" data-customer-count="${leads.length}" data-verified-customer-date="${leads.filter(x=>x.dateVerified).length}" data-fallback-date="${leads.filter(x=>!x.dateVerified).length}"><thead><tr><th>#</th><th>Khách hàng</th>'
);
source=source.replaceAll(
  '<td><b>${esc(x.name)}</b><br><small>${esc(x.conversation_id)}</small></td>',
  '<td>${x.showCustomerName===false?"":\`<b>\${esc(x.name)}</b><br><small>\${esc(x.conversation_id)}</small>\`}</td>'
);
source=source.replaceAll(
  '<td>${esc(x.product)}</td><td class="tags">',
  '<td>${esc(x.product)}</td><td>${esc(x.source_type||"Tin nhắn")}</td><td class="tags">'
);
source=source.replace(
  '<th>Quảng cáo</th><th>Sản phẩm</th><th>Tag Pancake</th>',
  '<th>Quảng cáo</th><th>Sản phẩm</th><th>Nguồn khách</th><th>Tag Pancake</th>'
);
source=source.replace('colspan="10">Không có khách phù hợp.', 'colspan="11">Không có khách phù hợp.');

fs.writeFileSync(file,source,"utf8");
console.log("[AIGUKA] Meta reports concurrent; account timezone and Ads Manager attribution settings applied; counters separated");
