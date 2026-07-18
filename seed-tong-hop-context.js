import fs from "node:fs";
import crypto from "node:crypto";

const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";

async function rest(path, init = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: init.method || "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      prefer: init.prefer || "return=representation",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(data?.message || data?.hint || data?.error || `SUPABASE_${response.status}`);
  return data;
}

async function seed() {
  if (!supabaseUrl || !key) throw new Error("SUPABASE_NOT_CONFIGURED");
  const baseContext = fs.readFileSync(new URL("./contexts/tong-hop.md", import.meta.url), "utf8").trim();
  const strictOverrides = fs.readFileSync(new URL("./contexts/tong-hop-overrides.md", import.meta.url), "utf8").trim();
  const content = `${baseContext}\n\n${strictOverrides}`;
  const seedHash = crypto.createHash("sha256").update(content).digest("hex");
  const existing = (await rest("v8_ai_contexts?context_key=eq.tong_hop_aiguka_aicake&select=*&limit=1"))?.[0] || null;

  if (existing?.metadata?.seed_hash === seedHash) {
    console.log("[AIGUKA] Context Tổng hợp already seeded");
    return;
  }

  const versionNo = existing ? Number(existing.current_version || 0) + 1 : 1;
  const metadata = {
    ...(existing?.metadata || {}),
    seed_hash: seedHash,
    seed_version: "2026-07-18.2",
    test_only_until_approved: true,
    pending_page_assignment: true,
    source_file: "contexts/tong-hop.md + contexts/tong-hop-overrides.md",
    merged_sources: ["AIcake customer-care context", "AIGUKA safety/runtime", "AIGUKA prompt inventory"],
    automation_rules_kept_outside_context: true,
  };
  const row = {
    context_key: "tong_hop_aiguka_aicake",
    context_name: "Tổng hợp",
    page_id: null,
    source_type: "merged_aiguka_aicake",
    content,
    usage_mode: "OFF",
    priority: 5,
    is_active: true,
    current_version: versionNo,
    metadata,
    updated_by: "seed_tong_hop_context",
    updated_at: new Date().toISOString(),
    ...(existing ? {} : { created_by: "seed_tong_hop_context" }),
  };

  const saved = existing
    ? (await rest(`v8_ai_contexts?id=eq.${encodeURIComponent(existing.id)}`, { method: "PATCH", body: row }))?.[0]
    : (await rest("v8_ai_contexts", { method: "POST", body: row }))?.[0];

  if (!saved?.id) throw new Error("CONTEXT_SAVE_FAILED");

  await rest("v8_ai_context_versions", {
    method: "POST",
    body: {
      context_id: saved.id,
      version_no: versionNo,
      context_name: "Tổng hợp",
      page_id: null,
      source_type: "merged_aiguka_aicake",
      content,
      usage_mode: "OFF",
      priority: 5,
      is_active: true,
      change_note: "Siết bản test: một câu hỏi cho sản phẩm mơ hồ, không kéo tiếp tin xác nhận ngắn, không liệt kê giả định giá",
      metadata,
      created_by: "seed_tong_hop_context",
    },
  });

  console.log(`[AIGUKA] Seeded context Tổng hợp v${versionNo} (${content.length} chars), OFF and unassigned`);
}

try {
  await seed();
} catch (error) {
  console.error("[AIGUKA] Could not seed context Tổng hợp:", error.message);
}
