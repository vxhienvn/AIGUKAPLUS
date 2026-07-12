import fs from "node:fs";

const file="server-fixed.js";
let source=fs.readFileSync(file,"utf8");

if(!source.includes('from "./report-handler.js"')){
  source=source.replace(
    'import { createProxyMiddleware } from "http-proxy-middleware";',
    'import { createProxyMiddleware } from "http-proxy-middleware";\nimport { installReportRoutes } from "./report-handler.js";\nimport { installLearningRoutes } from "./learning-handler.js";\nimport { patchLearningUi } from "./learning-ui-patch.js";'
  );
}
if(!source.includes('from "./learning-handler.js"')){
  source=source.replace('import { installReportRoutes } from "./report-handler.js";','import { installReportRoutes } from "./report-handler.js";\nimport { installLearningRoutes } from "./learning-handler.js";');
}
if(!source.includes('from "./learning-ui-patch.js"')){
  source=source.replace('import { installLearningRoutes } from "./learning-handler.js";','import { installLearningRoutes } from "./learning-handler.js";\nimport { patchLearningUi } from "./learning-ui-patch.js";');
}

if(!source.includes('installReportRoutes(app')){
  source=source.replace('const proxyCommon = {','installReportRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});\ninstallLearningRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});\n\nconst proxyCommon = {');
}else if(!source.includes('installLearningRoutes(app')){
  source=source.replace('installReportRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});','installReportRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});\ninstallLearningRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});');
}

if(!source.includes('patchLearningUi(html)')){
  source=source.replace('html = injectTestBootstrap(html);','html = injectTestBootstrap(html);\n  if(slug === "aiguka-v8-learning-ui-v18") html = patchLearningUi(html);');
}
source=source.replace('const url = `${SUPABASE_URL}/functions/v1/aiguka-v8-report-api?action=filters`;','const url = `http://127.0.0.1:${PORT}/functions/v1/aiguka-v8-report-api?action=filters`;');
source=source.replace('1.0.3-test-no-browser-key','1.0.5-learning-tags');
source=source.replace('1.0.4-test-rpc-data','1.0.5-learning-tags');
fs.writeFileSync(file,source);
console.log('[AIGUKA] server-fixed.js patched for report, learning and source links');