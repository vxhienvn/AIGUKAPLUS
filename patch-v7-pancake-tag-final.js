import fs from "node:fs";
import { spawnSync } from "node:child_process";

const serviceFile = "v7-pancake-service.cjs";
let service = fs.readFileSync(serviceFile, "utf8");
if (!service.includes("AIGUKA_PANCAKE_TAG_FINAL_V1")) {
  if (!service.includes("AIGUKA_PANCAKE_TAG_PARSER_V3")) throw new Error("PANCAKE_TAG_FINAL_REQUIRES_PARSER_V3");
  service = service.replace(
    '        if (!name) return;\n        const key = name.normalize("NFKC").toLocaleLowerCase("vi");',
    '        if (!name) return;\n        const key = name.normalize("NFKC").toLocaleLowerCase("vi");\n        if (["tag removed", "removed tag", "tag deleted", "xóa tag", "xoá tag"].includes(key)) return;',
  );
  service = service.replace("// AIGUKA_PANCAKE_TAG_PARSER_V3", "// AIGUKA_PANCAKE_TAG_PARSER_V3\n// AIGUKA_PANCAKE_TAG_FINAL_V1");
  fs.writeFileSync(serviceFile, service, "utf8");
  const serviceSyntax = spawnSync(process.execPath, ["--check", serviceFile], { encoding: "utf8" });
  if (serviceSyntax.status !== 0) throw new Error(`PANCAKE_TAG_FINAL_SERVICE_SYNTAX_FAILED:${serviceSyntax.stderr || serviceSyntax.stdout}`);
}

const dashboardFile = "v7-dashboard-stable.js";
let source = fs.readFileSync(dashboardFile, "utf8");
if (source.includes("AIGUKA_PANCAKE_TAG_FINAL_V1")) {
  console.log("[AIGUKA] Final Pancake tag cleanup already installed");
} else {
  if (!source.includes("AIGUKA_PANCAKE_TAG_COMPLETENESS_V4")) throw new Error("PANCAKE_TAG_FINAL_REQUIRES_COMPLETENESS_V4");

  source = source.replace(
    '    if (!text) continue;\n    const key = text.normalize("NFKC").toLocaleLowerCase("vi");\n    if (!map.has(key)) map.set(key, text);',
    '    if (!text) continue;\n    const key = text.normalize("NFKC").toLocaleLowerCase("vi");\n    if (["tag removed", "removed tag", "tag deleted", "xóa tag", "xoá tag"].includes(key)) continue;\n    if (!map.has(key)) map.set(key, text);',
  );

  source = source.replace(
    'const ignored=new Set(["zalo","có sđt","đã gọi","đã quét","đã quet","knm","chưa rõ sản phẩm","hẹn ra ch","hẹn ra cửa hàng","hen ra ch","hen ra cua hang","k mua","không mua"]);',
    'const ignored=new Set(["zalo","có sđt","đã gọi","đã quét","đã quet","knm","chưa rõ sản phẩm","hẹn ra ch","hẹn ra cửa hàng","hen ra ch","hen ra cua hang","k mua","không mua","tag removed","removed tag","tag deleted","xóa tag","xoá tag"]);',
  );

  const oldTotals = `    const careTotal=items.map(item=>careHtml(date,item.accountId)).filter(html=>!html.includes("Chưa xác định")).join("<br>")||'<span class="muted">Chưa xác định</span>';
    const metaTotal=items.map(item=>metaHtml(date,item.accountId)).filter(html=>!html.includes("Không có khách mới Meta")).join("<br>")||'<span class="muted">Không có khách mới Meta</span>';`;

  const newTotals = `    const accountIds=new Set(items.map(item=>act(item.accountId)));
    const mergeStaffDay=(sourceMap)=>{
      const totals=new Map();
      for(const [key,item] of sourceMap){
        const parts=String(key).split("|");
        if(parts[0]!==date||!accountIds.has(parts[1]))continue;
        const normalized=String(item.name||"").normalize("NFKC").trim().toLocaleLowerCase("vi");
        if(!normalized)continue;
        const total=totals.get(normalized)||{name:item.name,customers:new Set(),contacts:new Set()};
        for(const value of item.customers||[])total.customers.add(value);
        for(const value of item.contacts||[])total.contacts.add(value);
        totals.set(normalized,total);
      }
      return [...totals.values()].sort((a,b)=>String(a.name).localeCompare(String(b.name),"vi"));
    };
    const careDay=mergeStaffDay(careByKey);
    const careTotal=careDay.length?careDay.map(item=>'<span class="staff-stat care-stat" data-staff-name="'+esc(item.name)+'"><b>'+esc(item.name)+'</b>: '+item.customers.size+' khách · '+item.contacts.size+' số</span>').join("<br>"):'<span class="muted">Chưa xác định</span>';
    const metaDay=mergeStaffDay(metaByKey);
    const allMetaCustomers=new Set(),assignedMetaCustomers=new Set();
    for(const account of accountIds){
      const groupKey=date+"|"+account;
      for(const value of allMetaByAccountDay.get(groupKey)||[])allMetaCustomers.add(value);
      for(const value of assignedByAccountDay.get(groupKey)||[])assignedMetaCustomers.add(value);
    }
    const metaBlocks=metaDay.map(item=>'<span class="staff-stat meta-new-stat" data-staff-name="'+esc(item.name)+'"><b>'+esc(item.name)+'</b>: '+item.customers.size+' khách mới · '+item.contacts.size+' số</span>');
    const unknownMeta=Math.max(allMetaCustomers.size-assignedMetaCustomers.size,0);
    if(unknownMeta)metaBlocks.push('<span class="staff-stat muted"><b>Chưa gắn nhân viên</b>: '+unknownMeta+' khách mới</span>');
    const metaTotal=metaBlocks.join("<br>")||'<span class="muted">Không có khách mới Meta</span>';`;

  if (!source.includes(oldTotals)) throw new Error("PANCAKE_TAG_FINAL_DAILY_TOTAL_ANCHOR_NOT_FOUND");
  source = source.replace(oldTotals, newTotals);
  source = source.replace("// AIGUKA_PANCAKE_TAG_COMPLETENESS_V4", "// AIGUKA_PANCAKE_TAG_COMPLETENESS_V4\n// AIGUKA_PANCAKE_TAG_FINAL_V1");

  fs.writeFileSync(dashboardFile, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", dashboardFile], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`PANCAKE_TAG_FINAL_DASHBOARD_SYNTAX_FAILED:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Placeholder tags removed and daily staff totals merged by employee");
}
