import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_LEAD_REEL_REPLY_GUARD_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Reel reply guard V1 already installed");
} else {
  const start = source.indexOf("async function fetchRecoveredCommentLeadOrigins(since, until) {");
  const end = source.indexOf("\n\nfunction collectCreativePostKeys", start);
  if (start < 0 || end < 0) throw new Error("REEL_REPLY_GUARD_ANCHOR_NOT_FOUND");

  const replacement = String.raw`// AIGUKA_LEAD_REEL_REPLY_GUARD_V1
async function fetchRecoveredCommentLeadOrigins(since, until) {
  if (!cache.recoveredCommentLeadOrigins) cache.recoveredCommentLeadOrigins = new Map();
  const key = "reply-guard:" + String(since) + ":" + String(until);
  const hit = cache.recoveredCommentLeadOrigins.get(key);
  if (hit && Date.now() - hit.time < 60000) return hit.data;
  const startIso = shiftLeadDate(since, -2) + "T00:00:00Z";
  const endIso = shiftLeadDate(until, 3) + "T00:00:00Z";
  const result = { rows: [], error: null };
  try {
    const [comments, starts] = await Promise.all([
      fetchLeadRestRows(
        "v8_comment_events",
        "page_id,sender_id,sender_name,customer_id,event_time,post_id,comment_id,detected_phone,has_contact,private_reply_status",
        [["event_time", "gte." + startIso], ["event_time", "lt." + endIso], ["post_id", "not.is.null"]],
        "event_time.desc"
      ),
      fetchLeadRestRows(
        "v8_meta_conversation_starts",
        "page_id,page_name,sender_id,customer_id,conversation_id,customer_name,phone,zalo,tags,lead_score,product_key,conversation_started_at,first_message_text,last_message_at,last_message_text,message_count,has_phone,has_zalo",
        [["conversation_started_at", "gte." + startIso], ["conversation_started_at", "lt." + endIso]],
        "conversation_started_at.desc"
      ),
    ]);
    const latestStart = new Map();
    for (const row of starts) {
      const identity = String(row.page_id || "") + "|" + String(row.sender_id || "");
      if (!latestStart.has(identity)) latestStart.set(identity, row);
    }
    const seen = new Set();
    for (const comment of comments) {
      const pageId = String(comment.page_id || "");
      const senderId = String(comment.sender_id || "");
      const postId = String(comment.post_id || "");
      if (!pageId || !senderId || !postId) continue;
      const conversation = latestStart.get(pageId + "|" + senderId);
      if (!conversation) continue;
      const firstText = String(conversation.first_message_text || "").trim();
      const lastText = String(conversation.last_message_text || "").trim();
      const messageCount = Number(conversation.message_count || 0);
      const hasCustomerReply = Boolean(
        firstText || lastText || messageCount > 0 || conversation.has_phone || conversation.has_zalo || conversation.phone || conversation.zalo
      );
      if (!hasCustomerReply) continue;
      const unique = pageId + "|" + senderId + "|" + postId;
      if (seen.has(unique)) continue;
      seen.add(unique);
      const phones = [...new Set([comment.detected_phone, conversation.phone].filter(Boolean).map(String))];
      result.rows.push({
        name: conversation.customer_name || comment.sender_name || ("Khách ..." + senderId.slice(-6)),
        customer_id: senderId,
        sender_id: senderId,
        page_id: pageId,
        page_name: conversation.page_name || "",
        conversation_id: String(conversation.conversation_id || senderId),
        source_type: "Meta comment",
        conversation_started_at: conversation.conversation_started_at || comment.event_time,
        referral_at: comment.event_time,
        updated_at: conversation.last_message_at || comment.event_time,
        last_customer_message_at: conversation.last_message_at || comment.event_time,
        message_count: messageCount,
        has_phone: Boolean(comment.has_contact || conversation.has_phone || phones.length),
        has_zalo: Boolean(conversation.has_zalo || conversation.zalo),
        phones,
        product: conversation.product_key || "",
        hot_lead: Number(conversation.lead_score || 0) >= 60,
        tags: Array.from(new Set([
          ...(Array.isArray(conversation.tags) ? conversation.tags : []),
          ...(phones.length ? ["Có SĐT"] : []),
        ])),
        snippet: lastText || firstText || "Khách đến từ bình luận bài quảng cáo",
        adId: "",
        adName: "",
        postId,
        commentId: String(comment.comment_id || ""),
        referralSource: "COMMENT_NOTICE",
        isAdConversation: true,
      });
    }
  } catch (error) {
    result.error = error.message;
  }
  cache.recoveredCommentLeadOrigins.set(key, { time: Date.now(), data: result });
  return result;
}`;

  source = source.slice(0, start) + replacement + source.slice(end);
  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`REEL_REPLY_GUARD_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Reel comment origins count only after a real Messenger reply");
}
