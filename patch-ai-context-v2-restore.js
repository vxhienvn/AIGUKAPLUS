import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "ai-context-manager-v2.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_AI_CONTEXT_V2_RESTORE_FIXED";

if (source.includes(marker)) {
  console.log("[AIGUKA] AI Context V2 restore already fixed");
} else {
  const needle = 'res.json({ ok: true, data: await saveContext({ id, ...version, change_note: `Khôi phục phiên bản ${no}` }, "ai_context_restore") });';
  const replacement = 'res.json({ ok: true, data: await saveContext({ ...version, id, change_note: `Khôi phục phiên bản ${no}`, metadata: { ...(version.metadata || {}), restored_from_version: no } }, "ai_context_restore") }); // AIGUKA_AI_CONTEXT_V2_RESTORE_FIXED';
  if (!source.includes(needle)) throw new Error("AI_CONTEXT_V2_RESTORE_ANCHOR_NOT_FOUND");
  source = source.replace(needle, replacement);
  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`AI_CONTEXT_V2_RESTORE_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] AI Context V2 restore fixed");
}
