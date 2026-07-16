import fs from "node:fs";

const file = "server-fixed.js";
let source = fs.readFileSync(file, "utf8");

const importAnchor = 'import { createProxyMiddleware } from "http-proxy-middleware";';
const imports = `${importAnchor}
import { installReportRoutes } from "./report-handler.js";
import { installLearningRoutes } from "./learning-handler.js";
import { installReviewedLearning } from "./reviewed-learning-ui.js";
import { installMetaFacebookLogin } from "./meta-facebook-login.js";
import { patchLearningUi } from "./learning-ui-patch.js";
import { patchDashboardUi } from "./dashboard-ui-patch.js";
import { repairExtraUiHtml } from "./repair-ui.js";
import { installStableV7Dashboard } from "./v7-dashboard-stable.js";`;

if (!source.includes('from "./v7-dashboard-stable.js"')) {
  if (source.includes(importAnchor)) source = source.replace(importAnchor, imports);
  else throw new Error("SERVER_IMPORT_ANCHOR_NOT_FOUND");
}
if (!source.includes('from "./reviewed-learning-ui.js"')) {
  source = source.replace(
    'import { installLearningRoutes } from "./learning-handler.js";',
    'import { installLearningRoutes } from "./learning-handler.js";\nimport { installReviewedLearning } from "./reviewed-learning-ui.js";',
  );
}
if (!source.includes('from "./meta-facebook-login.js"')) {
  source = source.replace(
    'import { installReviewedLearning } from "./reviewed-learning-ui.js";',
    'import { installReviewedLearning } from "./reviewed-learning-ui.js";\nimport { installMetaFacebookLogin } from "./meta-facebook-login.js";',
  );
}

const routeInstall = `installReportRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});
installLearningRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});
app.json = express.json;
installReviewedLearning(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});
installMetaFacebookLogin(app);
app.get("/learning",(_req,res)=>res.redirect(302,"/learning-reviewed"));
pageRoutes.set("/v8-dashboard","aiguka-v8-admin");
pageRoutes.set("/v8-control-center","aiguka-v8-meta-admin");
pageRoutes.set("/v8-learning","aiguka-v8-learning-ui-v18");
installStableV7Dashboard(app);`;

if (!source.includes("installStableV7Dashboard(app)")) {
  const routeAnchor = "const proxyCommon = {";
  if (!source.includes(routeAnchor)) throw new Error("SERVER_ROUTE_ANCHOR_NOT_FOUND");
  source = source.replace(routeAnchor, `${routeInstall}\n\n${routeAnchor}`);
} else {
  if (!source.includes("installReviewedLearning(app")) {
    source = source.replace(
      "installLearningRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});",
      "installLearningRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});\napp.json = express.json;\ninstallReviewedLearning(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});\napp.get(\"/learning\",(_req,res)=>res.redirect(302,\"/learning-reviewed\"));",
    );
  }
  if (!source.includes("installMetaFacebookLogin(app)")) {
    source = source.replace(
      "installReviewedLearning(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});",
      "installReviewedLearning(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});\ninstallMetaFacebookLogin(app);",
    );
  }
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
  "1.3.2-v7-all-account-filter-fixed","1.3.3-card-and-column-filters"
]) source = source.replaceAll(version, "1.3.4-practical-lead-filters");

fs.writeFileSync(file, source);
console.log("[AIGUKA] Practical lead filters enabled: no STT/name filter; contact status only");