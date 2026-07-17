import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "drive-slide-manager-v3.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_DRIVE_V3_SAFE_ASSET_UPSERT";

if (source.includes(marker)) {
  console.log("[AIGUKA] Drive V3 safe asset upsert already installed");
} else {
  const start = source.indexOf("      let count = 0; for (const [index, item] of images.entries()) {");
  const end = source.indexOf("      if (mappingId) await db(", start);
  if (start < 0 || end < 0) throw new Error("DRIVE_V3_SAFE_UPSERT_ANCHOR_NOT_FOUND");

  const replacement = `      // AIGUKA_DRIVE_V3_SAFE_ASSET_UPSERT\n      let count = 0;\n      for (const [index, item] of images.entries()) {\n        const assetRow = {\n          product_key: productKey,\n          product_name: mapping?.product_name || productKey,\n          catalog_key: productKey,\n          root_folder_url: \`https://drive.google.com/drive/folders/\${folderId}\`,\n          parent_folder_id: item.parent_folder_id || folderId,\n          parent_folder_name: item.parent_folder_name || mapping?.product_name || \"\",\n          parent_folder_url: \`https://drive.google.com/drive/folders/\${item.parent_folder_id || folderId}\`,\n          drive_file_id: item.id,\n          file_name: item.name,\n          mime_type: item.mimeType,\n          file_url: item.webViewLink || \`https://drive.google.com/file/d/\${item.id}/view\`,\n          delivery_url: \`https://drive.google.com/uc?export=view&id=\${item.id}\`,\n          file_size: item.size ? Number(item.size) : null,\n          created_time: item.createdTime || null,\n          modified_time: item.modifiedTime || null,\n          sort_order: index + 1,\n          is_image: true,\n          is_active: true,\n          last_seen_at: new Date().toISOString(),\n          deleted_from_drive_at: null,\n        };\n        const existing = await db(\`v8_drive_assets?drive_file_id=eq.\${encodeURIComponent(item.id)}&select=id&limit=1\`);\n        if (existing?.[0]?.id) {\n          await db(\`v8_drive_assets?id=eq.\${encodeURIComponent(existing[0].id)}\`, { method: \"PATCH\", body: JSON.stringify(assetRow) });\n        } else {\n          await db(\"v8_drive_assets\", { method: \"POST\", body: JSON.stringify(assetRow) });\n        }\n        count++;\n      }\n`;

  source = source.slice(0, start) + replacement + source.slice(end);
  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`DRIVE_V3_SAFE_UPSERT_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Drive V3 safe asset upsert installed");
}
