import crypto from "node:crypto";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";

function storeReady() {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && META_APP_SECRET);
}

function deriveKey() {
  if (!META_APP_SECRET) throw new Error("MISSING_META_APP_SECRET");
  return crypto.scryptSync(META_APP_SECRET, "aiguka-meta-oauth-v1", 32);
}

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    token_cipher: encrypted.toString("base64"),
    token_iv: iv.toString("base64"),
    token_tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptToken(row) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveKey(),
    Buffer.from(row.token_iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(row.token_tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.token_cipher, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function headers(extra = {}) {
  if (!SERVICE_ROLE_KEY) throw new Error("MISSING_SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: SERVICE_ROLE_KEY,
    authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function request(path, options = {}) {
  if (!SUPABASE_URL) throw new Error("MISSING_SUPABASE_URL");
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: headers(options.headers || {}),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(data?.message || data?.error || `SUPABASE_HTTP_${response.status}`);
  return data;
}

export async function saveMetaConnection({
  facebookUserId,
  facebookUserName,
  accessToken,
  scopes = [],
  adAccounts = [],
}) {
  if (!storeReady()) throw new Error("META_OAUTH_STORE_NOT_CONFIGURED");
  const encrypted = encryptToken(accessToken);

  await request("/rest/v1/v8_meta_oauth_connections?active=eq.true", {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
  });

  const payload = {
    facebook_user_id: String(facebookUserId),
    facebook_user_name: facebookUserName || null,
    ...encrypted,
    granted_scopes: scopes,
    ad_accounts: adAccounts,
    active: true,
    updated_at: new Date().toISOString(),
    last_verified_at: new Date().toISOString(),
  };

  return request("/rest/v1/v8_meta_oauth_connections?on_conflict=facebook_user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payload),
  });
}

export async function loadActiveMetaConnection() {
  if (!storeReady()) return null;
  const rows = await request(
    "/rest/v1/v8_meta_oauth_connections?active=eq.true&select=*&order=updated_at.desc&limit=1",
    { method: "GET" },
  );
  if (!Array.isArray(rows) || !rows[0]) return null;
  const row = rows[0];
  return {
    facebookUserId: row.facebook_user_id,
    facebookUserName: row.facebook_user_name,
    accessToken: decryptToken(row),
    scopes: row.granted_scopes || [],
    adAccounts: row.ad_accounts || [],
    updatedAt: row.updated_at,
  };
}

export async function listMetaConnections() {
  if (!storeReady()) return [];
  const rows = await request(
    "/rest/v1/v8_meta_oauth_connections?select=facebook_user_id,facebook_user_name,granted_scopes,ad_accounts,active,updated_at&order=updated_at.desc",
    { method: "GET" },
  );
  return Array.isArray(rows) ? rows : [];
}

export function metaOAuthStoreConfigured() {
  return storeReady();
}