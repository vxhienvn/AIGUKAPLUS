import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");

if (!source.includes("AIGUKA_META_PRIMARY_LEADS_V2")) {
  throw new Error("V7_REFERRAL_SOURCE_REQUIRES_LEADS_V2");
}

// Chỉ sửa loader của trang Lead. Tuyệt đối không replace toàn file vì Báo cáo ngày
// dùng v8_meta_conversation_starts + conversation_started_at.
const fetchStart = source.indexOf("async function fetchMetaConversationStarts(since, until) {");
const fetchEnd = source.indexOf("\n\nasync function resolveLeadAdMap", fetchStart);
if (fetchStart < 0 || fetchEnd < 0) {
  throw new Error("V7_REFERRAL_SOURCE_FETCH_BLOCK_NOT_FOUND");
}

let fetchBlock = source.slice(fetchStart, fetchEnd);
fetchBlock = fetchBlock
  .replaceAll("fetchMetaConversationStarts", "fetchMetaAdReferralEntries")
  .replaceAll("cache.metaConversationStarts", "cache.metaAdReferralEntries")
  .replaceAll('params.append("conversation_started_at",', 'params.append("referral_at",')
  .replaceAll('params.set("order", "conversation_started_at.desc")', 'params.set("order", "referral_at.desc")')
  .replaceAll("/rest/v1/v8_meta_conversation_starts?", "/rest/v1/v8_meta_ad_referral_entries?")
  .replaceAll("SUPABASE_META_STARTS_", "SUPABASE_META_REFERRALS_")
  .replaceAll("conversation_started_at: row.conversation_started_at,", "conversation_started_at: row.referral_at,\n        referral_at: row.referral_at,")
  .replaceAll("updated_at: row.last_message_at,", "updated_at: row.referral_at,")
  .replaceAll("last_customer_message_at: row.last_message_at,", "last_customer_message_at: row.referral_at,")
  .replaceAll("message_count: Number(row.message_count || 0),", "message_count: 1,")
  .replaceAll('snippet: row.last_message_text || row.first_message_text || "",', 'snippet: row.referral_message_text || "",')
  .replaceAll("isAdConversation: row.is_ad_conversation === true,", "isAdConversation: row.is_ad_referral === true,");

source = source.slice(0, fetchStart) + fetchBlock + source.slice(fetchEnd);

const loadStart = source.indexOf('async function loadUnifiedLeadReport(p, selected = "all") {');
const loadEnd = source.indexOf("\n\nasync function leadsPage", loadStart);
if (loadStart < 0 || loadEnd < 0) {
  throw new Error("V7_REFERRAL_SOURCE_REPORT_BLOCK_NOT_FOUND");
}

let loadBlock = source.slice(loadStart, loadEnd);
loadBlock = loadBlock
  .replaceAll("const [accounts, meta, pancake, starts] = await Promise.all([", "const [accounts, meta, pancake, referrals] = await Promise.all([")
  .replaceAll("fetchMetaConversationStarts(p.since, p.until)", "fetchMetaAdReferralEntries(p.since, p.until)")
  .replaceAll("(starts.rows || [])", "(referrals.rows || [])")
  .replaceAll("    starts,\n    leads,", "    referrals,\n    leads,");
source = source.slice(0, loadStart) + loadBlock + source.slice(loadEnd);

// leadsPage nằm ngoài loadBlock, nên phải đổi property trên toàn source sau khi
// loadUnifiedLeadReport đã trả về `referrals` thay cho `starts`.
source = source.replaceAll("report.starts.error", "report.referrals.error");

source = source.replaceAll(
  "Mỗi khách chỉ tính 1 lần · theo múi giờ riêng của từng tài khoản quảng cáo",
  "Mỗi khách từ từng QC chỉ tính 1 lần/ngày · gồm cả khách cũ quay lại từ quảng cáo",
);

const dailyStart = source.indexOf("async function fetchMetaFirstCustomerStarts");
const dailyEnd = source.indexOf("\n\nasync function dailyPage", dailyStart);
const dailyBlock = dailyStart >= 0 && dailyEnd > dailyStart ? source.slice(dailyStart, dailyEnd) : "";
const leadFetchStart = source.indexOf("async function fetchMetaAdReferralEntries");
const leadFetchEnd = source.indexOf("\n\nasync function resolveLeadAdMap", leadFetchStart);
const leadFetchBlock = leadFetchStart >= 0 && leadFetchEnd > leadFetchStart ? source.slice(leadFetchStart, leadFetchEnd) : "";
const leadsPageStart = source.indexOf("async function leadsPage(req,res)");
const installStart = source.indexOf("export function installStableV7Dashboard", leadsPageStart);
const leadsPageBlock = leadsPageStart >= 0 && installStart > leadsPageStart ? source.slice(leadsPageStart, installStart) : "";

if (
  !dailyBlock.includes("/rest/v1/v8_meta_conversation_starts?") ||
  !dailyBlock.includes('params.append("conversation_started_at",') ||
  dailyBlock.includes("/rest/v1/v8_meta_ad_referral_entries?")
) {
  throw new Error("V7_REFERRAL_SOURCE_CORRUPTED_DAILY_META_LOADER");
}
if (
  !leadFetchBlock.includes("/rest/v1/v8_meta_ad_referral_entries?") ||
  !leadFetchBlock.includes('params.append("referral_at",') ||
  leadFetchBlock.includes('params.append("conversation_started_at",')
) {
  throw new Error("V7_REFERRAL_SOURCE_LEAD_LOADER_INVALID");
}
if (!source.includes("const [accounts, meta, pancake, referrals]")) {
  throw new Error("V7_REFERRAL_SOURCE_REPORT_RENAME_FAILED");
}
if (!leadsPageBlock.includes("report.referrals.error") || leadsPageBlock.includes("report.starts.error")) {
  throw new Error("V7_REFERRAL_SOURCE_LEADS_PAGE_PROPERTY_MISMATCH");
}

fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] Lead referral source patched without touching Daily Meta first-start loader");
