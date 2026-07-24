import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_LEAD_ACCOUNT_RECONCILE_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Lead account reconciliation already installed");
} else {
  if (!source.includes("AIGUKA_SPLIT_LEADS_AD_PERFORMANCE_V1")) {
    throw new Error("LEAD_ACCOUNT_RECONCILE_REQUIRES_SPLIT_LEADS");
  }

  const helperAnchor = "async function leadsPage(req,res) {";
  if (!source.includes(helperAnchor)) {
    throw new Error("LEAD_ACCOUNT_RECONCILE_HELPER_ANCHOR_NOT_FOUND");
  }

  const helpers = String.raw`// AIGUKA_LEAD_ACCOUNT_RECONCILE_V1
async function fetchLeadAccountCandidates(p) {
  const base=String(process.env.SUPABASE_URL||'https://ezygfpeeqbbirdeazene.supabase.co').replace(/\/$/,'');
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_ANON_KEY||process.env.SUPABASE_PUBLISHABLE_KEY||'';
  if(!key)return {rows:[],pageAccounts:[]};
  const headers={apikey:key,authorization:'Bearer '+key};
  const leadParams=new URLSearchParams({
    select:'report_date,page_id,page_name,customer_id,sender_id,conversation_id,customer_name,phone,zalo,tags,product_key,ad_id,ad_title,first_message_at,last_message_at,last_snippet,source_type',
    order:'first_message_at.asc',
    limit:'5000'
  });
  leadParams.append('report_date','gte.'+p.since);
  leadParams.append('report_date','lte.'+p.until);
  const pageParams=new URLSearchParams({select:'page_id,ad_account_id,is_primary,purpose',limit:'5000'});
  try{
    const [leadResponse,pageResponse]=await Promise.all([
      fetch(base+'/rest/v1/v8_meta_customer_leads_daily?'+leadParams.toString(),{headers,signal:AbortSignal.timeout(20000),cache:'no-store'}),
      fetch(base+'/rest/v1/v8_meta_page_ad_accounts?'+pageParams.toString(),{headers,signal:AbortSignal.timeout(20000),cache:'no-store'})
    ]);
    if(!leadResponse.ok||!pageResponse.ok)return {rows:[],pageAccounts:[]};
    return {rows:await leadResponse.json(),pageAccounts:await pageResponse.json()};
  }catch{return {rows:[],pageAccounts:[]}}
}

function metaAccountCustomerTargets(report) {
  const totals=new Map();
  for(const row of report?.meta?.rows||[]){
    const id=act(row.accountId||row.ad_account_id||'');
    if(!id)continue;
    const count=Number(row.messages??row.metaConversations??row.meta_conversations??row.messagingConversationsStarted??row.messaging_conversations_started??row.conversations??0)||0;
    totals.set(id,(totals.get(id)||0)+count);
  }
  return totals;
}

async function reconcileLeadRowsToMetaAccountTotals(baseLeads,report,p,selected) {
  const leads=Array.isArray(baseLeads)?[...baseLeads]:[];
  const targets=metaAccountCustomerTargets(report);
  if(!targets.size)return leads;
  const accountInfo=new Map((report.accounts||[]).map(row=>[act(row.id||row.accountId||row.account_id),row]));
  const existingKeys=new Set();
  const accountKeys=new Map();
  for(const lead of leads){
    const key=leadIdentity(lead)||String(lead.sender_id||lead.customer_id||lead.conversation_id||'');
    if(key)existingKeys.add(key);
    const accountId=act(lead.accountId||lead.ad_account_id||'');
    if(accountId&&key){
      if(!accountKeys.has(accountId))accountKeys.set(accountId,new Set());
      accountKeys.get(accountId).add(key);
    }
  }
  const extra=await fetchLeadAccountCandidates(p);
  const primaryByPage=new Map();
  for(const link of extra.pageAccounts||[]){
    const pageId=String(link.page_id||'');
    const accountId=act(link.ad_account_id||'');
    if(!pageId||!accountId)continue;
    if(link.is_primary===true){primaryByPage.set(pageId,accountId);continue}
    if(!primaryByPage.has(pageId)&&String(link.purpose||'').toLowerCase()==='reporting')primaryByPage.set(pageId,accountId);
  }
  const candidates=[];
  for(const row of extra.rows||[]){
    const accountId=primaryByPage.get(String(row.page_id||''))||'';
    if(!accountId||!targets.has(accountId))continue;
    if(selected!=='all'&&act(selected)!==accountId)continue;
    const identity=leadIdentity(row)||String(row.sender_id||row.customer_id||row.conversation_id||'');
    if(!identity||existingKeys.has(identity))continue;
    candidates.push({row,accountId,identity});
  }
  candidates.sort((a,b)=>new Date(a.row.first_message_at||0)-new Date(b.row.first_message_at||0));
  for(const candidate of candidates){
    const target=Math.max(0,Number(targets.get(candidate.accountId)||0));
    if(!accountKeys.has(candidate.accountId))accountKeys.set(candidate.accountId,new Set());
    const matched=accountKeys.get(candidate.accountId);
    if(matched.size>=target)continue;
    const row=candidate.row;
    const account=accountInfo.get(candidate.accountId)||{};
    leads.push({
      ...row,
      name:row.customer_name||'',
      customer_name:row.customer_name||'',
      phones:row.phone?[String(row.phone)]:[],
      has_zalo:Boolean(row.zalo),
      conversation_started_at:row.first_message_at,
      referral_at:row.first_message_at,
      accountId:candidate.accountId,
      accountName:account.name||account.accountName||(candidate.accountId==='311242249583664'?'Nguyệt Bếp-TB Vệ Sinh':candidate.accountId),
      accountTimezone:account.timezone||account.accountTimezone||'',
      campaignId:'',campaignName:'',campaignStatus:'',
      adsetId:'',adsetName:'',adsetStatus:'',
      adId:'',adName:'',adStatus:'',
      product:row.product_key||'',
      source_type:(row.source_type||'Meta Business')+' · đối soát tài khoản',
      snippet:row.last_snippet||'',
      tags:Array.isArray(row.tags)?row.tags:[],
      reconciliation_level:'account'
    });
    existingKeys.add(candidate.identity);
    matched.add(candidate.identity);
  }
  return leads;
}

`;
  source = source.replace(helperAnchor, helpers + helperAnchor);

  const leadAnchor = "  const leads=await hydrateLeadEntityStatuses(report.leads||[]);";
  const leadReplacement = "  const reconciledLeads=await reconcileLeadRowsToMetaAccountTotals(report.leads||[],report,p,selected);\n  const leads=await hydrateLeadEntityStatuses(reconciledLeads);";
  if (!source.includes(leadAnchor)) {
    throw new Error("LEAD_ACCOUNT_RECONCILE_PAGE_ANCHOR_NOT_FOUND");
  }
  source = source.replace(leadAnchor, leadReplacement);

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`LEAD_ACCOUNT_RECONCILE_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Lead identities reconciled to Meta account totals without inventing ad attribution");
}
