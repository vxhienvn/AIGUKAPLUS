const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";

const clean = (value) => String(value ?? "").trim();
const cleanAccountId = (value) => clean(value).replace(/^act_/, "");

function supabaseHeaders(extra = {}) {
  if (!SERVICE_ROLE_KEY) throw new Error("MISSING_SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: SERVICE_ROLE_KEY,
    authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function supabaseRequest(path, options = {}) {
  if (!SUPABASE_URL) throw new Error("MISSING_SUPABASE_URL");
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: supabaseHeaders(options.headers || {}),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  const body = await response.text();
  let data;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    data = { raw: body.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `SUPABASE_HTTP_${response.status}`);
  }
  return data;
}

async function resolveTenantApp() {
  const existing = await supabaseRequest(
    "/rest/v1/v8_meta_ad_accounts?select=tenant_id,meta_app_id&limit=1",
    { method: "GET" },
  );
  if (Array.isArray(existing) && existing[0]?.tenant_id && existing[0]?.meta_app_id) {
    return existing[0];
  }

  const tenants = await supabaseRequest(
    "/rest/v1/v8_tenants?tenant_key=eq.anh_duong_guka&select=id&limit=1",
    { method: "GET" },
  );
  const tenantId = tenants?.[0]?.id;
  if (!tenantId) throw new Error("META_SYNC_TENANT_NOT_FOUND");

  const apps = await supabaseRequest(
    `/rest/v1/v8_meta_apps?tenant_id=eq.${encodeURIComponent(tenantId)}&app_key=eq.aiguka_meta_core&select=id&limit=1`,
    { method: "GET" },
  );
  const metaAppId = apps?.[0]?.id;
  if (!metaAppId) throw new Error("META_SYNC_APP_NOT_FOUND");
  return { tenant_id: tenantId, meta_app_id: metaAppId };
}

async function syncActiveAdAccounts(connection) {
  const activeAccounts = (Array.isArray(connection?.adAccounts) ? connection.adAccounts : [])
    .map((account) => ({
      id: cleanAccountId(account?.id),
      name: clean(account?.name),
      status: Number(account?.account_status),
    }))
    .filter((account) => account.id && account.status === 1);

  if (!activeAccounts.length) return { synced: 0, names: new Map() };

  const { tenant_id, meta_app_id } = await resolveTenantApp();
  const now = new Date().toISOString();
  const rows = activeAccounts.map((account) => ({
    tenant_id,
    meta_app_id,
    ad_account_id: account.id,
    ad_account_name: account.name || account.id,
    account_status: "ACTIVE",
    permissions: [],
    reporting_enabled: true,
    management_enabled: false,
    is_active: true,
    source: "oauth_sync",
    last_verified_at: now,
    last_error: null,
    metadata: {
      oauth_snapshot: true,
      meta_account_status: account.status,
    },
    updated_at: now,
  }));

  await supabaseRequest(
    "/rest/v1/v8_meta_ad_accounts?on_conflict=ad_account_id",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    },
  );

  return {
    synced: rows.length,
    names: new Map(rows.map((row) => [row.ad_account_id, row.ad_account_name])),
  };
}

async function fetchMetaAds(adIds, accessToken) {
  const result = new Map();
  for (let offset = 0; offset < adIds.length; offset += 40) {
    const ids = adIds.slice(offset, offset + 40);
    const fields = "account_id,name,effective_status,campaign{id,name},adset{id,name}";
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/?ids=${encodeURIComponent(ids.join(","))}&fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(accessToken)}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.error) {
      throw new Error(body?.error?.message || `META_GRAPH_HTTP_${response.status}`);
    }
    for (const [adId, item] of Object.entries(body || {})) {
      if (!item || item.error || !item.account_id) continue;
      result.set(String(adId), item);
    }
  }
  return result;
}

async function patchRows(rows, concurrency = 8) {
  let updated = 0;
  for (let offset = 0; offset < rows.length; offset += concurrency) {
    const batch = rows.slice(offset, offset + concurrency);
    await Promise.all(batch.map(async ({ id, patch }) => {
      await supabaseRequest(`/rest/v1/ad_mappings?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(patch),
      });
      updated += 1;
    }));
  }
  return updated;
}

async function syncMissingAdMappings(connection, accountNames) {
  const mappings = await supabaseRequest(
    "/rest/v1/ad_mappings?select=id,ad_id,ad_account_id,is_active,enabled&limit=1000",
    { method: "GET" },
  );
  const missing = (Array.isArray(mappings) ? mappings : []).filter((row) =>
    row?.ad_id && !clean(row?.ad_account_id) && row?.is_active !== false && row?.enabled !== false
  );
  const adIds = [...new Set(missing.map((row) => clean(row.ad_id)).filter(Boolean))];
  if (!adIds.length) return { checked: 0, updated: 0, unresolved: 0 };

  const metaAds = await fetchMetaAds(adIds, connection.accessToken);
  const now = new Date().toISOString();
  const updates = [];
  for (const row of missing) {
    const adId = clean(row.ad_id);
    const ad = metaAds.get(adId);
    if (!ad?.account_id) continue;
    const accountId = cleanAccountId(ad.account_id);
    updates.push({
      id: row.id,
      patch: {
        ad_account_id: accountId,
        ad_account_name: accountNames.get(accountId) || accountId,
        ad_name: clean(ad.name) || undefined,
        campaign_id: clean(ad.campaign?.id) || null,
        campaign_name: clean(ad.campaign?.name) || null,
        adset_id: clean(ad.adset?.id) || null,
        adset_name: clean(ad.adset?.name) || null,
        effective_status: clean(ad.effective_status) || null,
        updated_at: now,
      },
    });
  }

  const updated = await patchRows(updates);
  return {
    checked: adIds.length,
    updated,
    unresolved: Math.max(adIds.length - metaAds.size, 0),
  };
}

export async function syncMetaAdAccountsAndMappings(connection) {
  if (!connection?.accessToken) return { skipped: "missing_access_token" };
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return { skipped: "missing_supabase_config" };

  const accounts = await syncActiveAdAccounts(connection);
  const mappings = await syncMissingAdMappings(connection, accounts.names);
  console.log(
    `[AIGUKA] Meta report accounts synced: ${accounts.synced}; ad mappings updated: ${mappings.updated}/${mappings.checked}; unresolved: ${mappings.unresolved}`,
  );
  return { accounts: accounts.synced, ...mappings };
}
