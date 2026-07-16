const PANCAKE_PAGE_ID = process.env.PANCAKE_PAGE_ID || process.env.META_PAGE_ID || process.env.PAGE_ID || "";
const PANCAKE_PAGE_ACCESS_TOKEN = process.env.PANCAKE_PAGE_ACCESS_TOKEN || "";
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
let pancakeCache = { rows: [], time: 0 };
let integrationCache = { value: null, time: 0 };

async function pancakeRuntime() {
    if (integrationCache.value && Date.now() - integrationCache.time < 30000) return integrationCache.value;
    let value = { connection_enabled: true, message_sync_enabled: true };
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
        try {
            const response = await fetch(SUPABASE_URL + "/rest/v1/v8_integration_runtime?integration_key=eq.pancake&select=connection_enabled,message_sync_enabled,status&limit=1", {
                headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY },
                signal: AbortSignal.timeout(10000),
                cache: "no-store"
            });
            const rows = await response.json();
            if (response.ok && Array.isArray(rows) && rows[0]) value = rows[0];
        } catch {}
    }
    integrationCache = { value, time: Date.now() };
    return value;
}

function pancakeCleanHtml(html = "") {
    return String(html)
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
}

const PANCAKE_INTERNAL_PHONE_BLACKLIST = new Set([
    "0973693677"
]);

function pancakeNormalizePhoneText(raw = "") {
    return String(raw || "")
        .normalize("NFKC")
        .replace(/[＠@]/g, "0")
        .replace(/[oOÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠ]/g, "0")
        .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, "0");
}

function pancakeNormalizeVietnamesePhone(raw) {
    let text = pancakeNormalizePhoneText(raw);
    let digits = text.replace(/[^0-9+]/g, "");
    if (digits.startsWith("+84")) digits = "0" + digits.slice(3);
    digits = digits.replace(/[^0-9]/g, "");
    if (digits.length > 10 && digits.startsWith("84")) digits = "0" + digits.slice(2);
    return digits;
}

function pancakeIsValidVietnameseMobile(phone = "") {
    const n = pancakeNormalizeVietnamesePhone(phone);
    return /^0(3|5|7|8|9)[0-9]{8}$/.test(n) && !PANCAKE_INTERNAL_PHONE_BLACKLIST.has(n);
}

function pancakeExtractPhonesFromText(text = "") {
    const src = pancakeNormalizePhoneText(text);
    const matches = src.match(/(?:\+?84|0)[0-9\s.\-()]{8,18}/g) || [];
    const phones = [];
    for (const m of matches) {
        const n = pancakeNormalizeVietnamesePhone(m);
        if (pancakeIsValidVietnameseMobile(n) && !phones.includes(n)) phones.push(n);
    }
    return phones;
}

function pancakeDetectZaloFromText(text = "") {
    const t = String(text || "").toLowerCase();
    return /zalo|za\s*lo|zalo qr|qr zalo|quét zalo|quet zalo|kết bạn zalo|ket ban zalo/.test(t);
}

function pancakeGetTagNames(conv) {
    if (!Array.isArray(conv.tags)) return [];
    return conv.tags.filter(Boolean).map(tag => tag.text).filter(Boolean);
}

function pancakeGetPhones(conv) {
    const phones = [];
    const add = (value) => {
        const normalized = pancakeNormalizeVietnamesePhone(value);
        if (/^0[0-9]{9}$/.test(normalized) && !phones.includes(normalized)) phones.push(normalized);
    };
    if (Array.isArray(conv.recent_phone_numbers)) {
        for (const item of conv.recent_phone_numbers) add(item?.phone_number || item?.captured || item);
    }
    const textSources = [
        conv.snippet,
        conv.last_message,
        conv.message,
        ...(Array.isArray(conv.tags) ? conv.tags.map(t => t?.text || t?.name || "") : [])
    ];
    for (const text of textSources) {
        for (const phone of pancakeExtractPhonesFromText(text)) add(phone);
    }
    return phones;
}

function pancakeClassifyProduct(text = "") {
    const t = String(text).toLowerCase();
    if (t.includes("quạt") || t.includes("quat") || t.includes("guka") || t.includes("cánh") || t.includes("canh") || t.includes("động cơ") || t.includes("dong co")) return "Quạt";
    if (t.includes("bồn cầu") || t.includes("bon cau") || t.includes("thiết bị vệ sinh") || t.includes("thiet bi ve sinh") || t.includes("sen") || t.includes("lavabo") || t.includes("vòi") || t.includes("voi") || t.includes("chậu rửa") || t.includes("chau rua")) return "Thiết bị vệ sinh";
    if (t.includes("bếp") || t.includes("bep") || t.includes("hút mùi") || t.includes("hut mui") || t.includes("chậu rửa bát") || t.includes("chau rua bat")) return "Bếp";
    if (t.includes("bồn tắm") || t.includes("bon tam")) return "Bồn tắm";
    if (t.includes("combo") || t.includes("phòng tắm") || t.includes("phong tam") || t.includes("nhà tắm") || t.includes("nha tam")) return "Combo phòng tắm";
    return "Khác";
}

function pancakeIsHotLead(conv) {
    const text = String(conv.snippet || "").toLowerCase();
    return text.includes("giá") || text.includes("gia") || text.includes("bao nhiêu") || text.includes("bao nhieu") || text.includes("địa chỉ") || text.includes("dia chi") || text.includes("mua") || text.includes("lắp") || text.includes("lap") || text.includes("còn hàng") || text.includes("con hang") || text.includes("xem mẫu") || text.includes("xem mau") || text.includes("gửi mẫu") || text.includes("gui mau") || text.includes("xin mẫu") || text.includes("xin mau");
}

function pancakeBuildCustomerRow(conv) {
    const tags = pancakeGetTagNames(conv);
    const phones = pancakeGetPhones(conv);
    const snippet = pancakeCleanHtml(conv.snippet || "");
    const tagText = tags.join(" ");
    const hasZalo = tags.includes("Zalo") || pancakeDetectZaloFromText(snippet) || pancakeDetectZaloFromText(tagText);
    const product = pancakeClassifyProduct(snippet);
    const rawType = String(conv.type || conv.conversation_type || "").toLowerCase();
    const commentId = conv.comment_id || conv.comment?.id || conv.last_comment_id || "";
    const postId = conv.post_id || conv.post?.id || conv.comment?.post_id || conv.referral?.post_id || "";
    const isComment = Boolean(commentId) || /comment|bình luận|binh_luan/.test(rawType);
    const adIds = Array.from(new Set([
        ...(Array.isArray(conv.ad_ids) ? conv.ad_ids : []),
        conv.ad_id,
        conv.ad?.id,
        conv.referral?.ad_id,
        conv.referral?.source_ad_id
    ].filter(Boolean).map(String)));
    return {
        name: conv.from?.name || "Không rõ tên",
        customer_id: conv.from?.id || conv.customer_id || conv.sender_id || "",
        conversation_id: conv.id,
        type: conv.type,
        source_type: isComment ? "Bình luận" : "Tin nhắn",
        comment_id: commentId,
        post_id: postId,
        updated_at: conv.updated_at,
        last_customer_message_at: conv.last_customer_message_at || conv.last_message?.created_time || conv.last_message?.created_at || "",
        last_message_from_id: conv.last_message?.from?.id || conv.last_message?.sender_id || "",
        last_message_is_customer: isComment ? true : (conv.last_message?.from?.id ? String(conv.last_message.from.id) !== String(PANCAKE_PAGE_ID) : null),
        message_count: conv.message_count || 0,
        has_phone: Boolean(conv.has_phone || phones.length),
        has_zalo: hasZalo,
        phones,
        product,
        hot_lead: pancakeIsHotLead(conv),
        tags: Array.from(new Set([...tags, ...(hasZalo ? ["Zalo"] : []), ...(phones.length ? ["Có SĐT"] : [])])),
        snippet,
        ad_ids: adIds,
        ad_name: conv.ad_name || conv.ad?.name || conv.ad_title || conv.referral?.ad_name || "",
        ad_account_id: conv.ad_account_id || conv.account_id || conv.ad?.account_id || "",
        ad_account_name: conv.ad_account_name || conv.account_name || conv.ad?.account_name || ""
    };
}

async function pancakeFetchConversations(limit) {
    const runtime = await pancakeRuntime();
    if (runtime.connection_enabled === false) return [];
    if (!PANCAKE_PAGE_ID || !PANCAKE_PAGE_ACCESS_TOKEN) {
        return pancakeCache.rows;
    }
    const targetLimit = Math.min(Math.max(Number(limit) || 300, 1), 500);
    const allConversations = [];
    const seenIds = new Set();
    let lastConversationId = null;
    let safetyCounter = 0;
    while (allConversations.length < targetLimit && safetyCounter < 10) {
        safetyCounter++;
        let url = `https://pages.fm/api/public_api/v2/pages/${PANCAKE_PAGE_ID}/conversations?page_access_token=${encodeURIComponent(PANCAKE_PAGE_ACCESS_TOKEN)}`;
        if (lastConversationId) url += `&last_conversation_id=${encodeURIComponent(lastConversationId)}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(30000), cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (response.status === 429 || data?.error_code === 429) {
            return pancakeCache.rows;
        }
        if (!response.ok || !data.success) {
            if (pancakeCache.rows.length) return pancakeCache.rows;
            return [];
        }
        const batch = Array.isArray(data.conversations) ? data.conversations : [];
        if (batch.length === 0) break;
        for (const conv of batch) {
            if (!conv || !conv.id || seenIds.has(conv.id)) continue;
            seenIds.add(conv.id);
            allConversations.push(conv);
            if (allConversations.length >= targetLimit) break;
        }
        const lastItem = batch[batch.length - 1];
        if (!lastItem || !lastItem.id || lastItem.id === lastConversationId) break;
        lastConversationId = lastItem.id;
        if (batch.length < 60) break;
    }
    const rows = allConversations.slice(0, targetLimit);
    if (rows.length) pancakeCache = { rows, time: Date.now() };
    return rows;
}

function pancakeVietnamDateString(date = new Date()) {
    const vn = new Date(date.getTime() + 7 * 60 * 60 * 1000);
    return vn.toISOString().slice(0, 10);
}

function pancakeConversationDateString(updatedAt) {
    if (!updatedAt) return "";
    const d = new Date(updatedAt);
    if (Number.isNaN(d.getTime())) return String(updatedAt).slice(0, 10);
    return pancakeVietnamDateString(d);
}

function pancakeReviewFilterRows(rows, type) {
    const t = String(type || "all").toLowerCase();
    if (t === "hot") return rows.filter(x => x.hot_lead && !x.has_phone);
    if (t === "no-phone" || t === "no_phone") return rows.filter(x => !x.has_phone);
    if (t === "phone" || t === "has-phone" || t === "has_phone") return rows.filter(x => x.has_phone);
    if (t === "zalo") return rows.filter(x => x.tags.includes("Zalo"));
    if (t === "called" || t === "da-goi" || t === "đã-gọi") return rows.filter(x => x.tags.includes("Đã Gọi"));
    if (t === "no-called" || t === "chua-goi" || t === "chưa-gọi") return rows.filter(x => !x.tags.includes("Đã Gọi"));
    return rows;
}

function pancakeReviewTypeLabel(type) {
    const t = String(type || "all").toLowerCase();
    if (t === "hot") return "Khách nóng chưa có số";
    if (t === "no-phone" || t === "no_phone") return "Khách chưa có số";
    if (t === "phone" || t === "has-phone" || t === "has_phone") return "Khách đã có số";
    if (t === "zalo") return "Khách có tag Zalo";
    if (t === "called" || t === "da-goi" || t === "đã-gọi") return "Khách đã gọi";
    if (t === "no-called" || t === "chua-goi" || t === "chưa-gọi") return "Khách chưa gọi";
    return "Tất cả hội thoại hôm nay";
}

module.exports = {
    PANCAKE_PAGE_ID,
    PANCAKE_PAGE_ACCESS_TOKEN,
    pancakeCleanHtml,
    pancakeNormalizeVietnamesePhone,
    pancakeIsValidVietnameseMobile,
    pancakeExtractPhonesFromText,
    pancakeDetectZaloFromText,
    pancakeGetTagNames,
    pancakeGetPhones,
    pancakeClassifyProduct,
    pancakeIsHotLead,
    pancakeBuildCustomerRow,
    pancakeFetchConversations,
    pancakeVietnamDateString,
    pancakeConversationDateString,
    pancakeReviewFilterRows,
    pancakeReviewTypeLabel
};