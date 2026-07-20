import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { loadActiveMetaConnection } from "./meta-token-store.js";
import { syncMetaAdAccountsAndMappings } from "./meta-ad-account-sync.js";

try {
  const metaConnection = await loadActiveMetaConnection();
  if (metaConnection) await syncMetaAdAccountsAndMappings(metaConnection);
} catch (error) {
  console.error("[AIGUKA] Daily account sync failed:", error.message);
}

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_DAILY_RUNTIME_FALLBACK_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Daily runtime fallback already installed");
} else {
  const oldBlock = `  const [accounts,data,pancake,ads,firstStarts]=await Promise.all([
    getAccounts(),fetchDaily(p.since,p.until,selected),fetchPancakeRange(),fetchAds(p.since,p.until,selected),fetchMetaFirstCustomerStarts(p.since,p.until)
  ]);
  const dailyRows=Array.isArray(data&&data.rows)?data.rows:[];`;

  const newBlock = `  // AIGUKA_DAILY_RUNTIME_FALLBACK_V1
  const fetchRuntimeDaily=async()=>{
    const supabaseUrl=String(process.env.SUPABASE_URL||'').replace(/\\/$/,'');
    const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
    if(!supabaseUrl||!serviceKey)return{rows:[],error:'RUNTIME_DAILY_NOT_CONFIGURED'};
    try{
      const params=new URLSearchParams();
      params.set('select','report_date,page_id,page_name,ad_account_id,ad_account_name,spend_with_tax,conversations,meta_conversations,message_count,payment_method_last4');
      params.append('report_date','gte.'+p.since);
      params.append('report_date','lte.'+p.until);
      params.set('order','report_date.desc,page_name.asc,ad_account_name.asc');
      params.set('limit','10000');
      if(selected!=='all')params.append('ad_account_id','eq.'+selected);
      const response=await fetch(supabaseUrl+'/rest/v1/v8_report_daily_summary?'+params.toString(),{
        headers:{apikey:serviceKey,authorization:'Bearer '+serviceKey},
        signal:AbortSignal.timeout(20000),cache:'no-store'
      });
      const rows=await response.json().catch(()=>[]);
      if(!response.ok||!Array.isArray(rows))throw new Error(rows?.message||rows?.error||('RUNTIME_DAILY_'+response.status));
      return{rows,error:null};
    }catch(error){return{rows:[],error:String(error&&error.message||error)}}
  };

  const [accounts,data,pancake,ads,firstStarts,runtimeDaily]=await Promise.all([
    getAccounts(),fetchDaily(p.since,p.until,selected),fetchPancakeRange(),fetchAds(p.since,p.until,selected),fetchMetaFirstCustomerStarts(p.since,p.until),fetchRuntimeDaily()
  ]);
  const metaDailyRows=Array.isArray(data&&data.rows)?data.rows:[];
  const runtimeRows=Array.isArray(runtimeDaily&&runtimeDaily.rows)?runtimeDaily.rows:[];
  const dailyRows=[...metaDailyRows];
  const metaKeys=new Set(metaDailyRows.map(row=>String(row.date||'')+'|'+act(row.accountId||'')));
  const runtimeKeys=new Set();
  for(const row of runtimeRows){
    const date=String(row.report_date||''),realAccount=act(row.ad_account_id||'');
    if(!date)continue;
    if(selected!=='all'&&realAccount!==selected)continue;
    if(realAccount&&metaKeys.has(date+'|'+realAccount))continue;
    const accountId=realAccount||('page:'+String(row.page_id||''));
    const key=date+'|'+accountId;if(runtimeKeys.has(key))continue;runtimeKeys.add(key);
    const pageName=String(row.page_name||'Trang Facebook');
    dailyRows.push({
      date,accountId,
      accountName:realAccount?String(row.ad_account_name||realAccount):(pageName+' · Chưa xác định tài khoản QC'),
      spend:Number(row.spend_with_tax||0),
      messages:Number(row.meta_conversations||row.conversations||0),
      paymentMethod:row.payment_method_last4?'Thẻ •••• '+row.payment_method_last4:'Ads Insights chưa đồng bộ',
      cardLast4:String(row.payment_method_last4||''),
      runtimeFallback:true,pageId:String(row.page_id||''),messageCount:Number(row.message_count||0)
    });
  }`;

  if (!source.includes(oldBlock)) throw new Error("DAILY_RUNTIME_FALLBACK_ANCHOR_NOT_FOUND");
  source = source.replace(oldBlock, newBlock);
  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`DAILY_RUNTIME_FALLBACK_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Daily Report now falls back to real Meta conversation data for every Page");
}
