import fs from "node:fs";

const file="server-fixed.js";
let source=fs.readFileSync(file,"utf8");

if(!source.includes('from "./report-handler.js"')){
  source=source.replace(
    'import { createProxyMiddleware } from "http-proxy-middleware";',
    'import { createProxyMiddleware } from "http-proxy-middleware";\nimport { installReportRoutes } from "./report-handler.js";'
  );
}

if(!source.includes('installReportRoutes(app')){
  source=source.replace(
    'const proxyCommon = {',
    'installReportRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});\n\nconst proxyCommon = {'
  );
}

source=source.replace(
  'const url = `${SUPABASE_URL}/functions/v1/aiguka-v8-report-api?action=filters`;',
  'const url = `http://127.0.0.1:${PORT}/functions/v1/aiguka-v8-report-api?action=filters`;'
);
source=source.replace('1.0.3-test-no-browser-key','1.0.4-test-rpc-data');
fs.writeFileSync(file,source);
console.log('[AIGUKA] server-fixed.js patched for automatic RPC data');
