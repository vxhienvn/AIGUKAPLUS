import fs from "node:fs";

const file="server-fixed.js";
let source=fs.readFileSync(file,"utf8");

if(!source.includes('from "./report-handler.js"')){
  source=source.replace(
    'import { createProxyMiddleware } from "http-proxy-middleware";',
    'import { createProxyMiddleware } from "http-proxy-middleware";\nimport { installReportRoutes } from "./report-handler.js";\nimport { installLearningRoutes } from "./learning-handler.js";\nimport { patchLearningUi } from "./learning-ui-patch.js";\nimport { patchDashboardUi } from "./dashboard-ui-patch.js";\nimport { repairExtraUiHtml } from "./repair-ui.js";\nimport { installV7DashboardBridge } from "./v7-dashboard-bridge.js";'
  );
}
if(!source.includes('from "./learning-handler.js"'))source=source.replace('import { installReportRoutes } from "./report-handler.js";','import { installReportRoutes } from "./report-handler.js";\nimport { installLearningRoutes } from "./learning-handler.js";');
if(!source.includes('from "./learning-ui-patch.js"'))source=source.replace('import { installLearningRoutes } from "./learning-handler.js";','import { installLearningRoutes } from "./learning-handler.js";\nimport { patchLearningUi } from "./learning-ui-patch.js";');
if(!source.includes('from "./dashboard-ui-patch.js"'))source=source.replace('import { patchLearningUi } from "./learning-ui-patch.js";','import { patchLearningUi } from "./learning-ui-patch.js";\nimport { patchDashboardUi } from "./dashboard-ui-patch.js";');
if(!source.includes('from "./repair-ui.js"'))source=source.replace('import { patchDashboardUi } from "./dashboard-ui-patch.js";','import { patchDashboardUi } from "./dashboard-ui-patch.js";\nimport { repairExtraUiHtml } from "./repair-ui.js";');
if(!source.includes('from "./v7-dashboard-bridge.js"'))source=source.replace('import { repairExtraUiHtml } from "./repair-ui.js";','import { repairExtraUiHtml } from "./repair-ui.js";\nimport { installV7DashboardBridge } from "./v7-dashboard-bridge.js";');

const routeInstall='installReportRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});\ninstallLearningRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});\npageRoutes.set("/v8-dashboard","aiguka-v8-admin");\npageRoutes.set("/v8-control-center","aiguka-v8-meta-admin");\npageRoutes.set("/v8-learning","aiguka-v8-learning-ui-v18");\ninstallV7DashboardBridge(app);';

if(!source.includes('installReportRoutes(app'))source=source.replace('const proxyCommon = {',routeInstall+'\n\nconst proxyCommon = {');
else{
  if(!source.includes('installLearningRoutes(app'))source=source.replace('installReportRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});','installReportRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});\ninstallLearningRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});');
  if(!source.includes('installV7DashboardBridge(app)'))source=source.replace('installLearningRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});','installLearningRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});\npageRoutes.set("/v8-dashboard","aiguka-v8-admin");\npageRoutes.set("/v8-control-center","aiguka-v8-meta-admin");\npageRoutes.set("/v8-learning","aiguka-v8-learning-ui-v18");\ninstallV7DashboardBridge(app);');
}

if(!source.includes('repairExtraUiHtml(html)'))source=source.replace('html = repairBrokenInterpolations(html);','html = repairBrokenInterpolations(html);\n  html = repairExtraUiHtml(html);');
if(!source.includes('patchLearningUi(html)'))source=source.replace('html = injectTestBootstrap(html);','html = injectTestBootstrap(html);\n  if(slug === "aiguka-v8-learning-ui-v18") html = patchLearningUi(html);');
if(!source.includes('patchDashboardUi(html)'))source=source.replace('if(slug === "aiguka-v8-learning-ui-v18") html = patchLearningUi(html);','if(slug === "aiguka-v8-learning-ui-v18") html = patchLearningUi(html);\n  if(slug === "aiguka-v8-admin") html = patchDashboardUi(html);');

if(!source.includes('AIGUKA_TWO_ARG_HANDLER_FIX'))source=source.replace('let html = input;','let html = input;\n  // AIGUKA_TWO_ARG_HANDLER_FIX\n  html = html.replace(/([A-Za-z_$][\\w$]*)\\(\'\'\\+(.+?)\\+\'\',\'\'\\+(.+?)\\+\'\'\\)/g, (_m,fn,a,b) => `${fn}(\\\\\'\' + ${a} + \'\\\\\',\\\\\'\' + ${b} + \'\\\\\')`);');

source=source.replace('const url = `${SUPABASE_URL}/functions/v1/aiguka-v8-report-api?action=filters`;','const url = `http://127.0.0.1:${PORT}/functions/v1/aiguka-v8-report-api?action=filters`;');
for(const v of ['1.0.3-test-no-browser-key','1.0.4-test-rpc-data','1.0.5-learning-tags','1.0.6-control-center-fix','1.0.7-all-ui-green'])source=source.replace(v,'1.1.0-v7-dashboard-bridge');
fs.writeFileSync(file,source);
console.log('[AIGUKA] V7 dashboard is primary; V8 modules kept on /v8-* routes');