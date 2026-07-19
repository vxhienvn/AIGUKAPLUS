export type J = Record<string, any>;
const txt = (v: any) => v == null ? null : (String(v).trim() || null);

export async function syncCustomerProfile(c: any, pageId: string, senderId: string) {
  try {
    const { data: existing } = await c.from("v8_customers")
      .select("display_name,profile_synced_at")
      .eq("page_id", pageId).eq("sender_id", senderId).maybeSingle();
    const last = existing?.profile_synced_at ? Date.parse(existing.profile_synced_at) : 0;
    if (existing?.display_name && last > Date.now() - 30 * 86400000) return;

    const { data: page } = await c.from("v8_pages")
      .select("token_secret_name").eq("page_id", pageId).eq("is_active", true).maybeSingle();
    const secret = txt(page?.token_secret_name);
    const token = secret ? Deno.env.get(secret) : null;
    if (!token) {
      await c.from("v8_customers").update({
        profile_sync_status: "missing_page_token",
        profile_sync_error: secret ? `Missing secret ${secret}` : "Page token is not configured",
      }).eq("page_id", pageId).eq("sender_id", senderId);
      return;
    }

    const version = txt(Deno.env.get("META_GRAPH_VERSION"));
    const base = version ? `https://graph.facebook.com/${version}` : "https://graph.facebook.com";
    const url = new URL(`${base}/${encodeURIComponent(senderId)}`);
    url.searchParams.set("fields", "first_name,last_name,profile_pic,locale");
    url.searchParams.set("access_token", token);
    const res = await fetch(url, { signal: AbortSignal.timeout(4500) });
    const profile = await res.json();
    if (!res.ok || profile?.error) {
      const msg = profile?.error?.message || `Graph HTTP ${res.status}`;
      await c.from("v8_customers").update({
        profile_sync_status: "error",
        profile_sync_error: msg,
        profile_synced_at: new Date().toISOString(),
        raw_profile: { source: "Meta", profile_error: profile?.error || msg },
      }).eq("page_id", pageId).eq("sender_id", senderId);
      return;
    }

    const first = txt(profile.first_name);
    const lastName = txt(profile.last_name);
    const display = [first, lastName].filter(Boolean).join(" ") || null;
    await c.from("v8_customers").update({
      first_name: first,
      last_name: lastName,
      display_name: display,
      profile_pic_url: txt(profile.profile_pic),
      locale: txt(profile.locale),
      profile_synced_at: new Date().toISOString(),
      profile_sync_status: "synced",
      profile_sync_error: null,
      raw_profile: { source: "Meta", ...profile },
    }).eq("page_id", pageId).eq("sender_id", senderId);
  } catch (error) {
    console.error("PROFILE_SYNC", error instanceof Error ? error.message : String(error));
  }
}
