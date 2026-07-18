import fs from "node:fs";

const file = "ai-context-center-v3.js";
const source = fs.readFileSync(file, "utf8");
const start = source.indexOf("<script>");
const end = source.indexOf("</script>", start);
if (start < 0 || end < 0) throw new Error("AI_CONTEXT_CENTER_SCRIPT_NOT_FOUND");
const browserScript = source.slice(start + "<script>".length, end);
try {
  new Function(browserScript);
} catch (error) {
  throw new Error(`AI_CONTEXT_CENTER_BROWSER_SCRIPT_INVALID:${error.message}`);
}
const requiredHandlers = [
  "save-version",
  "replace-master",
  "paste-all",
  "import-file",
  "archive-context",
  "run-test",
  "history-list",
];
for (const id of requiredHandlers) {
  if (!browserScript.includes(`$('${id}')`)) throw new Error(`AI_CONTEXT_CENTER_HANDLER_MISSING:${id}`);
}
console.log("[AIGUKA] Context Center V3 browser script and primary handlers validated");
