import fs from "node:fs";

const file = "v7-pancake-service.cjs";
let source = fs.readFileSync(file, "utf8");

if (source.includes("AIGUKA_PANCAKE_HISTORY_V2")) {
  console.log("[AIGUKA] Pancake history V2 already patched");
  process.exitCode = 0;
} else {
  const helperAnchor = "let integrationCache = { value: null, time: 0 };";
  if (!source.includes(helperAnchor)) throw new Error("PANCAKE_HISTORY_ANCHOR_NOT_FOUND:helper");
  const helpers = `${helperAnchor}

// AIGUKA_PANCAKE_HISTORY_V2
async function pancakeReadHistory(limit = 3000) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !PANCAKE_PAGE_ID) return [];
    try {
        const targetLimit = Math.min(Math.max(Number(limit) || 3000, 1), 3000);
        const response = await fetch(SUPABASE_URL + "/rest/v1/v8_pancake_conversation_cache?select=conversation&Page_id=eq.".replace("Page_id", "page_id") + encodeURIComponent(PANCAKE_PAGE_ID) + "&order=last_customer_message_at.desc.nullslast&limit=" + targetLimit, {
            headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY },
            signal: AbortSignal.timeout(20000),
            cache: "no-store"
        });
        const rows = await response.json().catch(() => []);
        if (!response.ok || !Array.isArray(rows)) return [];
        return rows.map(row => row?.conversation).filter(item => item && item.id);
    } catch { return []; }
}

async function pancakeSaveHistory(conversations = []) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !PANCAKE_PAGE_ID || !conversations.length) return;
    const rows = conversations.filter(item => item && item.id).map(conv => ({
        conversation_id: String(conv.id),
        page_id: String(PANCAKE_PAGE_ID),
        customer_id: String(conv.from?.id || conv.customer_id || conv.sender_id || "") || null,
        customer_name: conv.from?.name || null,
        updated_at: conv.updated_at || null,
        last_customer_message_at: conv.last_customer_message_at || conv.last_message?.created_time || conv.last_message?.created_at || conv.updated_at || null,
        staff_tags: Array.isArray(conv.tags) ? conv.tags.map(tag => tag?.text || tag?.name || "").filter(Boolean) : [],
        conversation: conv,
        synced_at: new Date().toISOString()
    }));
    for (let index = 0; index < rows.length; index += 250) {
        const batch = rows.slice(index, index + 250);
        try {
            await fetch(SUPABASE_URL + "/rest/v1/v8_pancake_conversation_cache?on_conflict=conversation_id", {
                method: "POST",
                headers: {
                    apikey: SUPABASE_SERVICE_ROLE_KEY,
                    authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
                    "content-type": "application/json",
                    prefer: "resolution=merge-duplicates,return=minimal"
                },
                body: JSON.stringify(batch),
                signal: AbortSignal.timeout(30000)
            });
        } catch {}
    }
}`;
  source = source.replace(helperAnchor, helpers);

  const functionPattern = /async function pancakeFetchConversations\(limit\) \{[\s\S]*?\n\}\n\nfunction pancakeVietnamDateString/;
  if (!functionPattern.test(source)) throw new Error("PANCAKE_HISTORY_ANCHOR_NOT_FOUND:fetch_function");
  const replacement = `async function pancakeFetchConversations(limit) {
    const runtime = await pancakeRuntime();
    if (runtime.connection_enabled === false || runtime.message_sync_enabled === false) return [];
    const targetLimit = Math.min(Math.max(Number(limit) || 3000, 1), 3000);
    if (!PANCAKE_PAGE_ID || !PANCAKE_PAGE_ACCESS_TOKEN) {
        const history = await pancakeReadHistory(targetLimit);
        return history.length ? history : pancakeCache.rows.slice(0, targetLimit);
    }
    const allConversations = [];
    const seenIds = new Set();
    let lastConversationId = null;
    let safetyCounter = 0;
    while (allConversations.length < targetLimit && safetyCounter < 60) {
        safetyCounter++;
        let url = \`https://pages.fm/api/public_api/v2/pages/\${PANCAKE_PAGE_ID}/conversations?page_access_token=\${encodeURIComponent(PANCAKE_PAGE_ACCESS_TOKEN)}\`;
        if (lastConversationId) url += \`&last_conversation_id=\${encodeURIComponent(lastConversationId)}\`;
        let response;
        let data;
        try {
            response = await fetch(url, { signal: AbortSignal.timeout(30000), cache: "no-store" });
            data = await response.json().catch(() => ({}));
        } catch {
            const history = await pancakeReadHistory(targetLimit);
            return history.length ? history : pancakeCache.rows.slice(0, targetLimit);
        }
        if (response.status === 429 || data?.error_code === 429) {
            const history = await pancakeReadHistory(targetLimit);
            return history.length ? history : pancakeCache.rows.slice(0, targetLimit);
        }
        if (!response.ok || !data.success) {
            const history = await pancakeReadHistory(targetLimit);
            return history.length ? history : pancakeCache.rows.slice(0, targetLimit);
        }
        const batch = Array.isArray(data.conversations) ? data.conversations : [];
        if (batch.length === 0) break;
        let added = 0;
        for (const conv of batch) {
            if (!conv || !conv.id || seenIds.has(conv.id)) continue;
            seenIds.add(conv.id);
            allConversations.push(conv);
            added++;
            if (allConversations.length >= targetLimit) break;
        }
        const lastItem = batch[batch.length - 1];
        if (!lastItem || !lastItem.id || lastItem.id === lastConversationId || added === 0) break;
        lastConversationId = lastItem.id;
    }
    const rows = allConversations.slice(0, targetLimit);
    if (rows.length) {
        pancakeCache = { rows, time: Date.now() };
        await pancakeSaveHistory(rows);
        return rows;
    }
    const history = await pancakeReadHistory(targetLimit);
    return history.length ? history : pancakeCache.rows.slice(0, targetLimit);
}

function pancakeVietnamDateString`;
  source = source.replace(functionPattern, replacement);

  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA] Pancake history paginated to 3000 and cached in Supabase");
}
