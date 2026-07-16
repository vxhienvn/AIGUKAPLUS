import fs from "node:fs";

const file = "server-fixed.js";
let source = fs.readFileSync(file, "utf8");

const importAnchor = 'import { createProxyMiddleware } from "http-proxy-middleware";';
const imports = `${importAnchor}
import { installReportRoutes } from "./report-handler.js";
import { installLearningRoutes } from "./learning-handler.js";
import { installLearningAdminV2 } from "./learning-admin-v2.js";
import { installReviewedLearning } from "./reviewed-learning-ui.js";
import { installBotControlUi } from "./bot-control-ui.js";
import { installMetaFacebookLogin } from "./meta-facebook-login.js";
import { patchLearningUi } from "./learning-ui-patch.js";
import { patchDashboardUi } from "./dashboard-ui-patch.js";
import { repairExtraUiHtml } from "./repair-ui.js";
import { installStableV7Dashboard } from "./v7-dashboard-stable.js";`;

if (!source.includes('from "./v7-dashboard-stable.js"')) {
  if (source.includes(importAnchor)) source = source.replace(importAnchor, imports);
  else throw new Error("SERVER_IMPORT_ANCHOR_NOT_FOUND");
}
if (!source.includes('from "./learning-admin-v2.js"')) {
  source = source.replace(
    'import { installLearningRoutes } from "./learning-handler.js";',
    'import { installLearningRoutes } from "./learning-handler.js";\nimport { installLearningAdminV2 } from "./learning-admin-v2.js";',
  );
}
if (!source.includes('from "./reviewed-learning-ui.js"')) {
  source = source.replace(
    'import { installLearningAdminV2 } from "./learning-admin-v2.js";',
    'import { installLearningAdminV2 } from "./learning-admin-v2.js";\nimport { installReviewedLearning } from "./reviewed-learning-ui.js";',
  );
}
if (!source.includes('from "./bot-control-ui.js"')) {
  source = source.replace(
    'import { installReviewedLearning } from "./reviewed-learning-ui.js";',
    'import { installReviewedLearning } from "./reviewed-learning-ui.js";\nimport { installBotControlUi } from "./bot-control-ui.js";',
  );
}
if (!source.includes('from "./meta-facebook-login.js"')) {
  source = source.replace(
    'import { installBotControlUi } from "./bot-control-ui.js";',
    'import { installBotControlUi } from "./bot-control-ui.js";\nimport { installMetaFacebookLogin } from "./meta-facebook-login.js";',
  );
}

const routeInstall = `installReportRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});
app.json = express.json;
installLearningRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY,serviceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY});
installLearningAdminV2(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY,serviceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY});
installBotControlUi(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY,serviceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY});
installReviewedLearning(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});
installMetaFacebookLogin(app);
app.get("/learning",(_req,res)=>res.redirect(302,"/learning-reviewed"));
app.get("/v8-learning",(_req,res)=>res.redirect(302,"/learning-reviewed"));
app.get("/control-center",(_req,res)=>res.redirect(302,"/bot-control"));
app.get("/v8-control-center",(_req,res)=>res.redirect(302,"/bot-control"));
pageRoutes.set("/v8-dashboard","aiguka-v8-admin");
installStableV7Dashboard(app);`;

if (!source.includes("installStableV7Dashboard(app)")) {
  const routeAnchor = "const proxyCommon = {";
  if (!source.includes(routeAnchor)) throw new Error("SERVER_ROUTE_ANCHOR_NOT_FOUND");
  source = source.replace(routeAnchor, `${routeInstall}\n\n${routeAnchor}`);
} else {
  const oldBlock = /installReportRoutes\(app,[\s\S]*?installStableV7Dashboard\(app\);/;
  if (oldBlock.test(source)) source = source.replace(oldBlock, routeInstall);
  else throw new Error("SERVER_EXISTING_ROUTE_BLOCK_NOT_FOUND");
}

if (!source.includes("repairExtraUiHtml(html)")) {
  source = source.replace("html = repairBrokenInterpolations(html);", "html = repairBrokenInterpolations(html);\n  html = repairExtraUiHtml(html);");
}
if (!source.includes("patchLearningUi(html)")) {
  source = source.replace("html = injectTestBootstrap(html);", 'html = injectTestBootstrap(html);\n  if(slug === "aiguka-v8-learning-ui-v18") html = patchLearningUi(html);');
}
if (!source.includes("patchDashboardUi(html)")) {
  source = source.replace('if(slug === "aiguka-v8-learning-ui-v18") html = patchLearningUi(html);', 'if(slug === "aiguka-v8-learning-ui-v18") html = patchLearningUi(html);\n  if(slug === "aiguka-v8-admin") html = patchDashboardUi(html);');
}

source = source.replace(
  'const url = `${SUPABASE_URL}/functions/v1/aiguka-v8-report-api?action=filters`;',
  'const url = `http://127.0.0.1:${PORT}/functions/v1/aiguka-v8-report-api?action=filters`;',
);

for (const version of [
  "1.0.3-test-no-browser-key","1.0.4-test-rpc-data","1.0.5-learning-tags",
  "1.0.6-control-center-fix","1.0.7-all-ui-green","1.1.0-v7-dashboard-bridge",
  "1.1.1-v7-import-pending","1.2.0-v7-stable-dashboard","1.2.1-reviewed-learning-restored",
  "1.2.2-reviewed-learning-startup-fix","1.3.0-facebook-login","1.3.1-facebook-callback-fixed",
  "1.3.2-v7-all-account-filter-fixed","1.3.3-card-and-column-filters","1.3.4-practical-lead-filters",
  "1.3.5-filter-card-fixed","1.4.0-learning-bot-control-restored"
]) source = source.replaceAll(version, "1.4.1-learning-data-complete");

fs.writeFileSync(file, source);
console.log("[AIGUKA] Product recognition, Prompt CRUD, BOT controls and conversation sync restored");