import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { syncCustomerProfile, type J } from "./profile.ts";
import { processFeedChange } from "./feed.ts";

const H = { "content-type": "application/json", "access-control-allow-origin": "*" };
const out = (x: J, status = 200) => new Response(JSON.stringify(x), { status, headers: H });
const txt = (v: any) => v == null ? null : (String(v).trim() || null);
const db = () => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const kind = (item: J) =>
  item.message?.is_echo ? "message_echo"
    : item.delivery ? "delivery"
    : item.read ? "read"
    : item.message ? "message"
    : item.postback ? "postback"
    : item.optin ? "marketing_optin"
    : item.referral ? "referral"
    : "unknown_messaging";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const verify = Deno.env.get("META_VERIFY_TOKEN") || "AIGUKA_V8_META_VERIFY";
    if (
      url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === verify
    ) {
      return new Response(url.searchParams.get("hub.challenge") || "", { status: 200 });
    }
    return out({
      ok: true,
      service: "aiguka-v8-webhook",
      architecture: "queue-first",
      mode: "PRODUCTION",
      version: "2026-07-23-v18-marketing-optin-promotion",
      marketing_optins: true,
    });
  }
  if (req.method !== "POST") return out({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  let body: J;
  try {
    body = await req.json();
  } catch {
    return out({ ok: false, error: "INVALID_JSON" }, 400);
  }

  const client = db();
  const postId = `post:${Date.now()}:${crypto.randomUUID()}`;
  const first = body.entry?.[0] || {};
  const audit = async (row: J) => {
    const { error } = await client.from("v8_webhook_audit").insert(row);
    if (error) console.error("AUDIT", error.message);
  };

  await audit({
    request_id: postId,
    page_id: txt(first.id),
    step: "POST_RECEIVED",
    status: "ok",
    detail: txt(body.object) || "unknown",
    payload_preview: {
      entry_count: Array.isArray(body.entry) ? body.entry.length : 0,
      has_messaging: Array.isArray(first.messaging),
      has_standby: Array.isArray(first.standby),
      has_changes: Array.isArray(first.changes),
    },
  });

  const counters: J = { saved: 0, skipped: 0, failed: 0, echoes: 0, comments: 0, optins: 0 };
  const profiles: Promise<void>[] = [];

  for (const entry of body.entry || []) {
    const pageId = txt(entry.id);
    for (const item of entry.messaging || []) {
      const eventKind = kind(item);
      if (!["message", "message_echo", "postback", "marketing_optin"].includes(eventKind)) {
        counters.skipped += 1;
        await audit({
          request_id: `${postId}:skip:${counters.skipped}`,
          page_id: pageId,
          sender_id: txt(item.sender?.id),
          message_id: txt(item.message?.mid),
          step: "POST_SKIPPED",
          status: "skipped",
          detail: eventKind,
          payload_preview: { reason: eventKind },
        });
        continue;
      }

      const message = item.message || {};
      const postback = item.postback || {};
      const optin = item.optin || {};
      const isEcho = eventKind === "message_echo";
      if (isEcho) counters.echoes += 1;
      const rawSender = txt(item.sender?.id);
      const rawRecipient = txt(item.recipient?.id) || pageId;
      const customer = isEcho ? rawRecipient : rawSender;
      const timestamp = Number(item.timestamp || Date.now());
      const messageId = txt(message.mid) || txt(postback.mid) || (
        eventKind === "marketing_optin"
          ? `optin:${pageId}:${customer}:${timestamp}`
          : `${pageId}:${customer}:${timestamp}`
      );
      const messageText = txt(message.text) || txt(postback.title) || txt(postback.payload) ||
        txt(optin.title) || txt(optin.payload) || txt(optin.notification_messages_status);
      const row = {
        meta_object: body.object,
        page_id: pageId,
        sender_id: rawSender,
        recipient_id: rawRecipient,
        message_id: messageId,
        conversation_id: txt(item.thread_id) || txt(item.conversation_id) || customer,
        message_text: messageText,
        timestamp_ms: timestamp,
        event_time: new Date(timestamp).toISOString(),
        referral: item.referral || message.referral || postback.referral || {},
        attachments: message.attachments || [],
        raw_payload: item,
        process_status: "processed",
      };

      await audit({
        request_id: messageId,
        page_id: pageId,
        sender_id: customer,
        message_id: messageId,
        step: eventKind === "marketing_optin" ? "MARKETING_OPTIN_RECEIVED" : (isEcho ? "ECHO_RECEIVED" : "RECEIVED"),
        status: "ok",
        detail: messageText || "",
        payload_preview: { kind: eventKind },
      });

      const { error } = await client.from("v8_meta_events").upsert(row, { onConflict: "page_id,message_id" });
      if (error) {
        counters.failed += 1;
        await audit({
          request_id: messageId,
          page_id: pageId,
          sender_id: customer,
          message_id: messageId,
          step: "EVENT_SAVE_FAILED",
          status: "error",
          error_code: "META_EVENT_UPSERT_FAILED",
          detail: error.message,
        });
      } else if (eventKind === "marketing_optin") {
        const { data: optinResult, error: optinError } = await client.rpc("v8_record_marketing_optin", {
          p_page_id: pageId,
          p_sender_id: customer,
          p_optin: optin,
          p_event_time: new Date(timestamp).toISOString(),
          p_raw_payload: item,
        });
        if (optinError) {
          counters.failed += 1;
          await audit({
            request_id: messageId,
            page_id: pageId,
            sender_id: customer,
            message_id: messageId,
            step: "MARKETING_OPTIN_PROCESS_FAILED",
            status: "error",
            error_code: "MARKETING_OPTIN_RPC_FAILED",
            detail: optinError.message,
          });
        } else {
          counters.saved += 1;
          counters.optins += 1;
          await audit({
            request_id: messageId,
            page_id: pageId,
            sender_id: customer,
            message_id: messageId,
            step: "MARKETING_OPTIN_COMPLETED",
            status: "ok",
            detail: String(optinResult?.status || "recorded"),
            payload_preview: { result: optinResult },
          });
          if (pageId && customer) profiles.push(syncCustomerProfile(client, pageId, customer));
        }
      } else {
        counters.saved += 1;
        await audit({
          request_id: messageId,
          page_id: pageId,
          sender_id: customer,
          message_id: messageId,
          step: "WEBHOOK_COMPLETED",
          status: "ok",
          detail: isEcho ? "outbound_echo_saved" : "inbound_saved",
        });
        if (!isEcho && pageId && customer) profiles.push(syncCustomerProfile(client, pageId, customer));
      }
    }

    for (const item of entry.standby || []) {
      counters.skipped += 1;
      await audit({
        request_id: `${postId}:standby:${counters.skipped}`,
        page_id: pageId,
        sender_id: txt(item.sender?.id),
        step: "POST_SKIPPED",
        status: "skipped",
        detail: "standby",
        payload_preview: { reason: "standby" },
      });
    }

    for (const change of entry.changes || []) {
      await processFeedChange(client, audit, postId, pageId, change, counters);
    }
  }

  if (counters.saved === 0 && counters.skipped === 0 && counters.comments === 0) {
    await audit({
      request_id: `${postId}:empty`,
      page_id: txt(first.id),
      step: "POST_SKIPPED",
      status: "skipped",
      detail: "empty_or_unknown_payload",
      payload_preview: { object: body.object || null },
    });
  }
  if (profiles.length) await Promise.allSettled(profiles);
  return out({ ok: counters.failed === 0, received: true, ...counters }, counters.failed ? 500 : 200);
});
