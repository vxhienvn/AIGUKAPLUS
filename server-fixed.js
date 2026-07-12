import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = String(
  process.env.SUPABASE_URL || "https://ezygfpeeqbbirdeazene.supabase.co",
).replace(/\/$/, "");
const SUPABASE_PUBLIC_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "";

if (!SUPABASE_PUBLIC_KEY) {
  console.warn(
    "[AIGUKA] Missing SUPABASE_PUBLISHABLE_KEY / SUPABASE_ANON_KEY. REST RPC routes may return 401.",
  );
}

const pageRoutes = new Map([
  ["/", "aiguka-v8-admin"],
  ["/dashboard", "aiguka-v8-admin"],
  ["/admin-v8", "aiguka-v8-admin"],
  ["/control-center", "aiguka-v8-meta-admin"],
  ["/readiness", "aiguka-v8-readiness"],
  ["/observe", "aiguka-v8-quality"],
  ["/quality", "aiguka-v8-quality"],
  ["/learning", "aiguka-v8-learning-ui-v18"],
  ["/aiguka-v8-admin", "aiguka-v8-admin"],
  ["/aiguka-v8-meta-admin", "aiguka-v8-meta-admin"],
  ["/aiguka-v8-readiness", "aiguka-v8-readiness"],
  ["/aiguka-v8-quality", "aiguka-v8-quality"],
  ["/aiguka-v8-learning-ui-v18", "aiguka-v8-learning-ui-v18"],
]);

function setProxyAuth(proxyReq, req) {
  if (SUPABASE_PUBLIC_KEY) {
    if (!req.headers.apikey) proxyReq.setHeader("apikey", SUPABASE_PUBLIC_KEY);
    if (!req.headers.authorization) {
      proxyReq.setHeader("authorization", `Bearer ${SUPABASE_PUBLIC_KEY}`);
    }
  }
  const adminSecret = req.headers["x-aiguka-admin-secret"];
  if (adminSecret) {
    proxyReq.setHeader("x-aiguka-admin-secret", String(adminSecret));
  }
}

const proxyCommon = {
  target: SUPABASE_URL,
  changeOrigin: true,
  secure: true,
  xfwd: true,
  proxyTimeout: 120_000,
  timeout: 120_000,
  on: {
    proxyReq: setProxyAuth,
    error(error, req, res) {
      console.error("[AIGUKA proxy]", error.message);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ ok: false, error: "SUPABASE_PROXY_ERROR" }));
    },
  },
};

app.use(
  "/functions/v1",
  createProxyMiddleware({
    ...proxyCommon,
    pathRewrite: (path) => `/functions/v1${path}`,
  }),
);

app.use(
  "/rest/v1",
  createProxyMiddleware({
    ...proxyCommon,
    pathRewrite: (path) => `/rest/v1${path}`,
  }),
);

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "aiguka-v8-railway-admin",
    version: "1.0.1-ui-handler-fix",
    supabase: SUPABASE_URL,
    public_key_configured: Boolean(SUPABASE_PUBLIC_KEY),
    now: new Date().toISOString(),
  });
});

function repairSupabaseUiHtml(html) {
  return html.replace(/''\+(.+?)\+''/g, "\\''+$1+'\\'");
}

async function serveSupabasePage(slug, res) {
  const url = `${SUPABASE_URL}/functions/v1/${slug}`;
  const upstream = await fetch(url, {
    headers: { accept: "text/plain, text/html;q=0.9, */*;q=0.8" },
    signal: AbortSignal.timeout(30_000),
  });

  let body = await upstream.text();
  body = repairSupabaseUiHtml(body);
  if (!upstream.ok) {
    res
      .status(upstream.status)
      .type("text/plain")
      .send(`Không tải được giao diện ${slug}: HTTP ${upstream.status}\n${body}`);
    return;
  }

  res.status(200);
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate");
  res.setHeader("pragma", "no-cache");
  res.setHeader("x-content-type-options", "nosniff");
  res.send(body);
}

for (const [path, slug] of pageRoutes.entries()) {
  app.get(path, async (_req, res) => {
    try {
      await serveSupabasePage(slug, res);
    } catch (error) {
      console.error(`[AIGUKA page ${slug}]`, error);
      res
        .status(502)
        .type("text/plain")
        .send(`Không tải được giao diện AIGUKA: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "NOT_FOUND" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[AIGUKA] Railway admin listening on 0.0.0.0:${PORT}`);
  console.log(`[AIGUKA] Supabase upstream: ${SUPABASE_URL}`);
});
