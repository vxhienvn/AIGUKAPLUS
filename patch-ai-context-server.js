import fs from "node:fs";

const file = "patch-server.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_AI_CONTEXT_SERVER_V1";

if (!source.includes(marker)) {
  source = source.replace(
    'import { installAiProviderManager } from "./ai-provider-manager.js";\\nimport { installDriveSlideManager } from "./drive-slide-manager.js";`;',
    'import { installAiProviderManager } from "./ai-provider-manager.js";\\nimport { installAiContextManager } from "./ai-context-manager.js";\\nimport { installDriveSlideManager } from "./drive-slide-manager.js";`; // AIGUKA_AI_CONTEXT_SERVER_V1',
  );

  source = source.replace(
    "if (!source.includes('from \"./drive-slide-manager.js\"')) {",
    `if (!source.includes('from "./ai-context-manager.js"')) {
  source = source.replace(
    'import { installAiProviderManager } from "./ai-provider-manager.js";',
    'import { installAiProviderManager } from "./ai-provider-manager.js";\\nimport { installAiContextManager } from "./ai-context-manager.js";',
  );
}
if (!source.includes('from "./drive-slide-manager.js"')) {`,
  );

  source = source.replace(
    "installAiProviderManager(app);\ninstallDriveSlideManager(app",
    "installAiProviderManager(app);\ninstallAiContextManager(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY,serviceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY});\ninstallDriveSlideManager(app",
  );

  source = source.replace(
    'app.get("/control-center",(_req,res)=>res.redirect(302,"/bot-control"));',
    'app.get("/context-ai",(_req,res)=>res.redirect(302,"/ai-contexts"));\napp.get("/control-center",(_req,res)=>res.redirect(302,"/bot-control"));',
  );

  source = source.replace(
    '"1.3.5-filter-card-fixed","1.4.0-learning-bot-control-restored"',
    '"1.3.5-filter-card-fixed","1.4.0-learning-bot-control-restored","1.4.1-learning-data-complete"',
  );
  source = source.replaceAll('"1.4.1-learning-data-complete"', '"1.5.0-ai-context-manager"');
  source = source.replace(
    'console.log("[AIGUKA] Product recognition, Prompt CRUD, BOT controls and conversation sync restored");',
    'console.log("[AIGUKA] AI Context, Product recognition, Prompt CRUD, BOT controls and conversation sync restored");',
  );

  fs.writeFileSync(file, source, "utf8");
}

console.log("[AIGUKA] AI Context server wiring installed");
