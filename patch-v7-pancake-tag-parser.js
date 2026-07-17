import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-pancake-service.cjs";
let source = fs.readFileSync(file, "utf8");

if (source.includes("AIGUKA_PANCAKE_TAG_PARSER_V3")) {
  console.log("[AIGUKA] Pancake tag parser V3 already installed");
} else {
  const tagFunction = /function pancakeGetTagNames\(conv\) \{[\s\S]*?\n\}/;
  if (!tagFunction.test(source)) throw new Error("PANCAKE_TAG_PARSER_ANCHOR_NOT_FOUND");

  source = source.replace(tagFunction, `// AIGUKA_PANCAKE_TAG_PARSER_V3
function pancakeGetTagNames(conv = {}) {
    const current = new Map();
    const tagName = (tag) => {
        if (typeof tag === "string") return tag.trim();
        if (!tag || typeof tag !== "object") return "";
        return String(tag.text || tag.name || tag.label || tag.title || "").trim();
    };
    const setTag = (tag, active = true) => {
        const name = tagName(tag);
        if (!name) return;
        const key = name.normalize("NFKC").toLocaleLowerCase("vi");
        if (active) current.set(key, name);
        else current.delete(key);
    };

    // Lịch sử giúp giữ đúng các tag được thêm/xóa, kể cả khi payload danh sách bị thiếu.
    const histories = Array.isArray(conv.tag_histories) ? [...conv.tag_histories] : [];
    histories.sort((left, right) => new Date(left?.inserted_at || 0) - new Date(right?.inserted_at || 0));
    for (const history of histories) {
        const payload = history?.payload || history || {};
        const action = String(payload.action || history?.action || "add").toLowerCase();
        setTag(payload.tag || history?.tag, !/remove|delete|detach/.test(action));
    }

    // Danh sách hiện tại là nguồn ưu tiên cuối cùng.
    for (const tag of (Array.isArray(conv.tags) ? conv.tags : [])) setTag(tag, true);
    for (const tag of (Array.isArray(conv.staff_tags) ? conv.staff_tags : [])) setTag(tag, true);

    return [...current.values()];
}`);

  source = source.replace(
    "        staff_tags: Array.isArray(conv.tags) ? conv.tags.map(tag => tag?.text || tag?.name || \"\").filter(Boolean) : [],",
    "        staff_tags: pancakeGetTagNames(conv),",
  );

  source = source.replace(
    '        name: conv.from?.name || "Không rõ tên",\n        customer_id: conv.from?.id || conv.customer_id || conv.sender_id || "",',
    '        name: conv.from?.name || conv.page_customer?.name || conv.customers?.[0]?.name || "Không rõ tên",\n        customer_id: conv.from?.id || conv.page_customer?.psid || conv.customers?.[0]?.fb_id || conv.customer_id || conv.sender_id || "",\n        sender_id: conv.from?.id || conv.page_customer?.psid || conv.customers?.[0]?.fb_id || conv.customer_id || conv.sender_id || "",\n        page_id: String(conv.page_id || conv.page?.id || PANCAKE_PAGE_ID || ""),',
  );

  source = source.replace(
    "        tags: Array.from(new Set([...tags, ...(hasZalo ? [\"Zalo\"] : []), ...(phones.length ? [\"Có SĐT\"] : [])])),",
    "        pancake_tags: [...tags],\n        tags: Array.from(new Set([...tags, ...(hasZalo ? [\"Zalo\"] : []), ...(phones.length ? [\"Có SĐT\"] : [])])),",
  );

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`PANCAKE_TAG_PARSER_SYNTAX_FAILED:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Pancake tags now support text/name/history and preserve page identity");
}
