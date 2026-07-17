import fs from "node:fs";

const file = "ai-context-manager.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_CONTEXT_GPT5_PARAMS_V1";

if (!source.includes(marker)) {
  const oldBlock = `      body: JSON.stringify({
        model,
        temperature: 0.35,
        max_tokens: 1200,
        messages: [`;
  const newBlock = `      body: JSON.stringify({
        model,
        // AIGUKA_CONTEXT_GPT5_PARAMS_V1
        ...((/^gpt-5|^o[1-9]/i).test(model)
          ? { max_completion_tokens: 1200 }
          : { temperature: 0.35, max_tokens: 1200 }),
        messages: [`;
  if (!source.includes(oldBlock)) throw new Error("AI_CONTEXT_OPENAI_BODY_ANCHOR_NOT_FOUND");
  source = source.replace(oldBlock, newBlock);
  fs.writeFileSync(file, source, "utf8");
}

console.log("[AIGUKA] GPT-5 compatible AI context test parameters installed");
