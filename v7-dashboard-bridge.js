import { createProxyMiddleware } from "http-proxy-middleware";

export function installV7DashboardBridge(app) {
  const baseUrl = String(
    process.env.AIGUKA_V7_BASE_URL || "https://manychat-openai-6oiq.onrender.com"
  ).replace(/\/+$/, "");

  const directPaths = new Set([
    "/",
    "/admin-v5",
    "/dashboard",
    "/dashboard-today",
    "/dashboard-yesterday",
    "/dashboard-hot",
    "/dashboard-meta-month",
    "/dashboard-source-debug",
    "/pancake-report-text",
    "/reports",
    "/daily-report",
    "/leads",
    "/customers",
    "/control-center"
  ]);

  const proxy = createProxyMiddleware({
    target: baseUrl,
    changeOrigin: true,
    secure: true,
    xfwd: true,
    proxyTimeout: 120000,
    timeout: 120000,
    on: {
      proxyReq(proxyReq) {
        proxyReq.setHeader("x-aiguka-bridge", "v8-uses-v7-dashboard");
      },
      error(error, _req, res) {
        console.error("[AIGUKA V7 dashboard bridge]", error.message);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        }
        res.end(JSON.stringify({ ok: false, error: "V7_DASHBOARD_UNREACHABLE" }));
      }
    }
  });

  app.get("/health/v7", async (_req, res) => {
    try {
      const response = await fetch(`${baseUrl}/admin-v5`, {
        signal: AbortSignal.timeout(30000),
        cache: "no-store"
      });
      const body = await response.text();
      res.status(response.ok ? 200 : 502).json({
        ok: response.ok,
        source: "AIGUKA_V7",
        base_url: baseUrl,
        upstream_status: response.status,
        html_bytes: body.length,
        checked_at: new Date().toISOString()
      });
    } catch (error) {
      res.status(502).json({
        ok: false,
        source: "AIGUKA_V7",
        base_url: baseUrl,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.use((req, res, next) => {
    const path = req.path || "/";
    const relatedPath =
      path.startsWith("/api/") ||
      path.startsWith("/dashboard-") ||
      path.startsWith("/pancake-");

    if (!directPaths.has(path) && !relatedPath) return next();

    if (path === "/") req.url = "/admin-v5";
    if (path === "/reports") req.url = "/dashboard-meta-month?limit=500";
    if (path === "/daily-report") req.url = "/dashboard?limit=500&preset=today";
    if (["/leads", "/customers", "/control-center"].includes(path)) {
      req.url = "/admin-v5";
    }

    return proxy(req, res, next);
  });

  return { baseUrl };
}
