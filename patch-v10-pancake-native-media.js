import fs from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "v10-outbound-worker.js";
const MARK = "AIGUKA_V10_PANCAKE_NATIVE_MEDIA_V1";

if (!fs.existsSync(FILE)) throw new Error("V10_PANCAKE_NATIVE_OUTBOUND_MISSING");
let source = fs.readFileSync(FILE, "utf8");

if (!source.includes(MARK)) {
  if (!source.includes('import { loadActiveMetaConnection } from "./meta-token-store.js";')) {
    throw new Error("V10_PANCAKE_NATIVE_IMPORT_ANCHOR_MISSING");
  }
  source = source.replace(
    'import { loadActiveMetaConnection } from "./meta-token-store.js";',
    'import { loadActiveMetaConnection } from "./meta-token-store.js";\nimport { sendPancakeNativeMedia, v10PancakeNativeMediaReady } from "./v10-pancake-native-media.js";',
  );

  const signature = "async function sendCarousel(pageId, recipientId, assets, salutation = null, groupLabel = null) {";
  if (!source.includes(signature)) throw new Error("V10_PANCAKE_NATIVE_CAROUSEL_SIGNATURE_MISSING");
  source = source.replace(signature, `${signature}\n  if (v10PancakeNativeMediaReady()) {\n    try {\n      const nativeResult = await sendPancakeNativeMedia({ pageId, recipientId, assets });\n      if (nativeResult && Array.isArray(nativeResult.content_ids) && nativeResult.content_ids.length) return nativeResult;\n    } catch (error) {\n      console.warn(\"[AIGUKA V10 Pancake media] native transport failed; falling back to Meta generic carousel:\", error instanceof Error ? error.message : String(error));\n    }\n  }`);

  const patchOutputAnchor = "      media_asset_count: media.assets.length,";
  if (source.includes(patchOutputAnchor)) {
    source = source.replace(
      patchOutputAnchor,
      `${patchOutputAnchor}\n      media_transport_preference: v10PancakeNativeMediaReady() ? \"pancake_native_with_meta_fallback\" : \"meta_carousel\",`,
    );
  }

  const heartbeatAnchor = "      media_assets_max_per_group: MAX_MEDIA_ASSETS,";
  if (source.includes(heartbeatAnchor)) {
    source = source.replace(
      heartbeatAnchor,
      `${heartbeatAnchor}\n      pancake_native_media: v10PancakeNativeMediaReady(),`,
    );
  }

  source = source.replace(/const VERSION = "v10_outbound_[^"]+";/, 'const VERSION = "v10_outbound_grouped_media_v12_pancake_native";');
  source += `\n// ${MARK}\n`;

  const syntax = spawnSync(process.execPath, ["--check", FILE], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`V10_PANCAKE_NATIVE_SYNTAX:${syntax.stderr || syntax.stdout}`);
  if (!source.includes("pancake_native_with_meta_fallback") || !source.includes("sendPancakeNativeMedia")) {
    throw new Error("V10_PANCAKE_NATIVE_INSTALL_FAILED");
  }
  fs.writeFileSync(FILE, source, "utf8");
}

console.log("[AIGUKA V10] Pancake native media enabled: slide batches are uploaded and sent as Pancake content_ids so all images remain visible in Pancake; Meta generic carousel remains automatic fallback");
