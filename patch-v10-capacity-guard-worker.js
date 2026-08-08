import fs from "node:fs";

const FILE = "v10-decision-queue-janitor.js";
const MARK = "AIGUKA_V10_CORE_CAPACITY_GUARD_V1";

if (!fs.existsSync(FILE)) throw new Error("V10_CAPACITY_GUARD_JANITOR_MISSING");

let source = fs.readFileSync(FILE, "utf8");
if (!source.includes(MARK)) {
  const pollAnchor = 'const POLL_MS = Math.max(1000, Number(process.env.AIGUKA_V10_JANITOR_POLL_MS || 2000));';
  if (!source.includes(pollAnchor)) throw new Error("V10_CAPACITY_GUARD_POLL_ANCHOR_MISSING");
  source = source.replace(
    pollAnchor,
    `${pollAnchor}\nconst CAPACITY_GUARD_MS = Math.max(5 * 60_000, Number(process.env.AIGUKA_V10_CAPACITY_GUARD_MS || 30 * 60_000));`,
  );

  const stateAnchor = 'let timer;';
  if (!source.includes(stateAnchor)) throw new Error("V10_CAPACITY_GUARD_STATE_ANCHOR_MISSING");
  source = source.replace(
    stateAnchor,
    `${stateAnchor}\nlet lastCapacityGuardAt = 0;\n\n// ${MARK}`,
  );

  const heartbeatAnchor = 'async function heartbeat(status, details = {}, error = null) {';
  if (!source.includes(heartbeatAnchor)) throw new Error("V10_CAPACITY_GUARD_HEARTBEAT_ANCHOR_MISSING");
  const helper = `async function maybeCapacityGuard() {\n  const now = Date.now();\n  if (now - lastCapacityGuardAt < CAPACITY_GUARD_MS) return null;\n  lastCapacityGuardAt = now;\n  try {\n    return await core("rpc/v10_capacity_guard_tick", {\n      method: "POST",\n      prefer: "return=representation",\n      body: {},\n      timeout: 20000,\n    });\n  } catch (error) {\n    return { ok: false, error: String(error?.message || error).slice(0, 500) };\n  }\n}\n\n`;
  source = source.replace(heartbeatAnchor, helper + heartbeatAnchor);

  const tickAnchor = '    const details = await cleanup();\n    await heartbeat("healthy", details);';
  if (!source.includes(tickAnchor)) throw new Error("V10_CAPACITY_GUARD_TICK_ANCHOR_MISSING");
  source = source.replace(
    tickAnchor,
    '    const details = await cleanup();\n    const capacityGuard = await maybeCapacityGuard();\n    await heartbeat("healthy", { ...details, capacity_guard: capacityGuard });',
  );

  source = source.replace(/const VERSION = "v10_queue_hygiene_[^"]+";/, 'const VERSION = "v10_queue_hygiene_v4_capacity_guard";');
  fs.writeFileSync(FILE, source, "utf8");
}

console.log("[AIGUKA V10] Core capacity guard attached to queue janitor; 30-minute checks, no DB cron");
