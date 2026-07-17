import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "drive-slide-manager-v3.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_DRIVE_V3_RECURSIVE_SYNC";
if (source.includes(marker)) {
  console.log("[AIGUKA] Drive V3 recursive sync already installed");
} else {
  const anchor = "  const graphToken = () =>";
  if (!source.includes(anchor)) throw new Error("DRIVE_V3_RECURSIVE_ANCHOR_NOT_FOUND");
  const helper = `  // AIGUKA_DRIVE_V3_RECURSIVE_SYNC\n  const listImagesRecursive = async (row, rootFolderId, maxDepth = 6) => {\n    const images = [];\n    const queue = [{ id: idFromUrl(rootFolderId), name: \"\", depth: 0 }];\n    const visited = new Set();\n    while (queue.length && visited.size < 500) {\n      const folder = queue.shift();\n      if (!folder?.id || visited.has(folder.id)) continue;\n      visited.add(folder.id);\n      const items = await listFolder(row, folder.id);\n      for (const item of items) {\n        if (isFolder(item.mimeType) && folder.depth < maxDepth) {\n          queue.push({ id: item.id, name: item.name, depth: folder.depth + 1 });\n        } else if (isImage(item.mimeType)) {\n          images.push({ ...item, parent_folder_id: folder.id, parent_folder_name: folder.name });\n        }\n        if (images.length >= 2000) break;\n      }\n      if (images.length >= 2000) break;\n    }\n    return { images, folders_scanned: visited.size };\n  };\n\n`;
  source = source.replace(anchor, helper + anchor);
  const oldSync = 'if (!productKey || !folderId) throw new Error("Thiếu mã sản phẩm hoặc thư mục Drive"); const items = await listFolder(row, folderId); const images = items.filter((x) => isImage(x.mimeType));';
  const newSync = 'if (!productKey || !folderId) throw new Error("Thiếu mã sản phẩm hoặc thư mục Drive"); const scan = await listImagesRecursive(row, folderId); const images = scan.images;';
  if (!source.includes(oldSync)) throw new Error("DRIVE_V3_SYNC_BLOCK_NOT_FOUND");
  source = source.replace(oldSync, newSync);
  source = source.replace('parent_folder_id: folderId, parent_folder_name: mapping?.product_name || "", parent_folder_url: `https://drive.google.com/drive/folders/${folderId}`', 'parent_folder_id: item.parent_folder_id || folderId, parent_folder_name: item.parent_folder_name || mapping?.product_name || "", parent_folder_url: `https://drive.google.com/drive/folders/${item.parent_folder_id || folderId}`');
  source = source.replace('res.json({ ok: true, synced: count, total_items: items.length });', 'res.json({ ok: true, synced: count, total_items: images.length, folders_scanned: scan.folders_scanned });');
  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`DRIVE_V3_RECURSIVE_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Drive V3 recursive folder sync installed");
}
