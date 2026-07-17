import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");

if (!source.includes("AIGUKA_META_PRIMARY_LEADS_V2")) {
  throw new Error("V7_REFERRAL_SOURCE_REQUIRES_LEADS_V2");
}

source = source
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
  .replaceAll("isAdConversation: row.is_ad_conversation === true,", "isAdConversation: row.is_ad_referral === true,")
  .replaceAll("const [accounts, meta, pancake, starts] = await Promise.all([", "const [accounts, meta, pancake, referrals] = await Promise.all([")
  .replaceAll("(starts.rows || [])", "(referrals.rows || [])")
  .replaceAll("    starts,\n    leads,", "    referrals,\n    leads,")
  .replaceAll("report.starts.error", "report.referrals.error")
  .replaceAll("Mỗi khách chỉ tính 1 lần · theo múi giờ riêng của từng tài khoản quảng cáo", "Mỗi khách từ từng QC chỉ tính 1 lần/ngày · gồm cả khách cũ quay lại từ quảng cáo");

if (!source.includes("v8_meta_ad_referral_entries") || !source.includes("const [accounts, meta, pancake, referrals]")) {
  throw new Error("V7_REFERRAL_SOURCE_PATCH_FAILED");
}

fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] Lead source switched to daily Meta ad referral events");
