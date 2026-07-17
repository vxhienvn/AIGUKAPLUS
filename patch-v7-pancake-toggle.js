import fs from "node:fs";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");

const css = `.pancake-nav-card{margin:12px 0 4px;padding:11px;border:1px solid #334155;border-radius:10px;background:#111c31;color:#dce5f4}.pancake-nav-title{font-weight:800;margin-bottom:5px}.pancake-nav-note{font-size:11px;line-height:1.35;color:#aab6ca;margin-bottom:9px}.pancake-nav-switch{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:700}.pancake-nav-switch input{width:38px;height:20px;accent-color:#22c55e}.pancake-nav-state{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11px;color:#aab6ca}.pancake-nav-dot{width:8px;height:8px;border-radius:50%;background:#94a3b8}.pancake-nav-dot.on{background:#22c55e}.pancake-nav-dot.error{background:#ef4444}`;
if (!source.includes(".pancake-nav-card")) source = source.replace("</style>", css + "</style>");

const slidesNav = "${nav('/drive-slides','🖼 Mapping & Test Slide','drive-slides')}";
const panel = `<div class="pancake-nav-card"><div class="pancake-nav-title">Nguồn bổ sung Pancake</div><div class="pancake-nav-note">Meta Business là nguồn chính. Chỉ bật Pancake để bù tag nhân viên và hội thoại Meta chưa kịp đồng bộ.</div><label class="pancake-nav-switch"><span>Bật Pancake</span><input id="pancake-global-toggle" type="checkbox"></label><div class="pancake-nav-state"><span id="pancake-global-dot" class="pancake-nav-dot"></span><span id="pancake-global-status">Đang tải trạng thái…</span></div></div>`;
if (!source.includes(slidesNav)) throw new Error("V7_PANCAKE_NAV_ANCHOR_NOT_FOUND");
if (!source.includes("pancake-global-toggle")) source = source.replace(slidesNav, slidesNav + panel);

const script = `<script>(function(){
const toggle=document.getElementById("pancake-global-toggle"),status=document.getElementById("pancake-global-status"),dot=document.getElementById("pancake-global-dot");
if(!toggle||!status||!dot)return;
function show(enabled,text,error){toggle.checked=Boolean(enabled);status.textContent=text;dot.className="pancake-nav-dot"+(error?" error":(enabled?" on":""));}
async function load(){toggle.disabled=true;try{const r=await fetch("/api/integrations/pancake",{cache:"no-store"}),j=await r.json();if(!r.ok||j.ok===false)throw new Error(j.error||"Không tải được");const enabled=j.data?.connection_enabled!==false&&j.data?.message_sync_enabled!==false;show(enabled,enabled?"Đang bật toàn hệ thống":"Đang tắt toàn hệ thống",false)}catch(e){show(false,"Lỗi đọc trạng thái",true)}finally{toggle.disabled=false}}
async function save(){const enabled=toggle.checked;toggle.disabled=true;status.textContent="Đang lưu…";try{const r=await fetch("/api/integrations/pancake",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({connection_enabled:enabled,message_sync_enabled:enabled})}),j=await r.json();if(!r.ok||j.ok===false)throw new Error(j.error||"Không lưu được");show(enabled,enabled?"Đã bật toàn hệ thống":"Đã tắt toàn hệ thống",false)}catch(e){show(!enabled,"Lỗi lưu trạng thái",true)}finally{toggle.disabled=false}}
toggle.addEventListener("change",save);load();
})();</script>`;
if (!source.includes("pancake-nav-dot\"+(error")) source = source.replace("</body>", script + "</body>");

fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] Persistent Pancake control installed in left navigation");
