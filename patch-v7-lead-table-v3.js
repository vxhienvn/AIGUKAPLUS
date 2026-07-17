import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "v7-dashboard-stable.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_LEAD_TABLE_V3_AND_EXPORT_TEMPLATE";
if (source.includes(marker)) {
  console.log("[AIGUKA] Lead table V3 and export template already installed");
} else {
  if (!source.includes('import * as XLSX from "xlsx";')) source = 'import * as XLSX from "xlsx";\n' + source;
  const loadStart = source.indexOf('async function loadUnifiedLeadReport(p, selected = "all") {');
  const leadsStart = source.indexOf("async function leadsPage(req,res)", loadStart);
  if (loadStart < 0 || leadsStart < 0) throw new Error("LEAD_V3_LOADER_ANCHOR_NOT_FOUND");
  let loader = source.slice(loadStart, leadsStart);
  const oldIdentity = `    const identity = leadIdentity(row);\n    if (!identity || seen.has(identity)) continue;`;
  const newIdentity = `    const identity = leadIdentity(row);\n    const adIdentity = String(row.adId || row.ad_id || "");\n    const rowIdentity = identity + "|ad:" + adIdentity;\n    if (!identity || !adIdentity || seen.has(rowIdentity)) continue;`;
  if (!loader.includes(oldIdentity)) throw new Error("LEAD_V3_IDENTITY_ANCHOR_NOT_FOUND");
  loader = loader.replace(oldIdentity, newIdentity).replace("    seen.add(identity);\n    paid.push(lead);", "    seen.add(rowIdentity);\n    paid.push(lead);");
  source = source.slice(0, loadStart) + loader + source.slice(leadsStart);

  const pageStart = source.indexOf("async function leadsPage(req,res)");
  const installStart = source.indexOf("export function installStableV7Dashboard", pageStart);
  if (pageStart < 0 || installStart < 0) throw new Error("LEAD_V3_PAGE_ANCHOR_NOT_FOUND");
  const page = String.raw`// AIGUKA_LEAD_TABLE_V3_AND_EXPORT_TEMPLATE
async function leadsPage(req,res) {
  const p=period(req.query,"dashboard");
  const selected=String(req.query.account||"all")==="all"?"all":act(req.query.account);
  const report=await loadUnifiedLeadReport(p,selected);
  const accounts=report.accounts||[],leads=report.leads||[];
  const groups=new Map();
  for(const lead of leads){
    const key=leadIdentity(lead)||("customer|"+String(lead.name||lead.customer_id||""));
    const group=groups.get(key)||{key,items:[],name:lead.name||"Khách hàng",phones:new Set(),hasZalo:false,maxTime:0};
    group.items.push(lead);for(const phone of lead.phones||[])if(phone)group.phones.add(String(phone));group.hasZalo=group.hasZalo||Boolean(lead.has_zalo);
    group.maxTime=Math.max(group.maxTime,new Date(lead.conversation_started_at||lead.referral_at||0).getTime()||0);groups.set(key,group);
  }
  const ordered=[...groups.values()].sort((a,b)=>b.maxTime-a.maxTime);
  let sequence=0;
  const rows=ordered.map(group=>{
    sequence++;
    group.items.sort((a,b)=>new Date(b.conversation_started_at||b.referral_at||0)-new Date(a.conversation_started_at||a.referral_at||0));
    const span=group.items.length;
    const contact=[...group.phones].join(", ")+(group.hasZalo?(group.phones.size?" · Zalo":"Zalo"):"");
    return group.items.map((x,index)=>{
      const groupCells=index===0
        ? '<td rowspan="'+span+'" class="lead-group-cell lead-seq"><b>'+sequence+'</b></td>'
          +'<td rowspan="'+span+'" class="lead-group-cell lead-customer"><b>'+esc(group.name)+'</b><br><small>'+esc([x.sender_id||x.customer_id,x.page_name].filter(Boolean).join(" · "))+'</small></td>'
          +'<td rowspan="'+span+'" class="lead-group-cell lead-contact">'+esc(contact)+'</td>'
        : '';
      const tags=(x.tags||[]).map(tag=>'<span class="lead-tag">'+esc(tag)+'</span>').join(' ');
      return '<tr class="lead-ad-row" data-customer="'+esc(group.name)+'" data-account="'+esc(x.accountName||'')+'" data-ad="'+esc(x.adName||'')+'" data-product="'+esc(x.product||'')+'">'
        +groupCells
        +'<td><b>'+esc(x.accountName||"Chưa xác định")+'</b><br><small>'+esc(x.accountTimezone||"")+'</small></td>'
        +'<td>'+esc(x.campaignName||"")+'</td>'
        +'<td>'+esc(x.adsetName||"")+'</td>'
        +'<td><b>'+esc(x.adName||"")+'</b><br><small>ID '+esc(x.adId||x.ad_id||"")+'</small></td>'
        +'<td>'+esc(x.product||"Khác")+'</td>'
        +'<td>'+esc(x.source_type||"Meta Business")+'</td>'
        +'<td class="tags">'+tags+'</td>'
        +'<td>'+esc(x.snippet||"")+'</td>'
        +'<td>'+esc(formatAccountLeadTime(x))+'</td>'
        +'</tr>';
    }).join('');
  }).join('');
  const accountCount=new Set(leads.map(x=>act(x.accountId)).filter(Boolean)).size;
  const contactCount=ordered.filter(x=>x.phones.size||x.hasZalo).length;
  const errors=[...(report.meta?.errors||[]),...(report.referrals?.error?[report.referrals.error]:[]),...(report.pancake?.error?[report.pancake.error]:[])];
  const note=report.unresolvedCount?'<div class="notice">Có '+report.unresolvedCount+' lượt quảng cáo chưa xác định được tài khoản QC; hệ thống không tự gán sai.</div>':'';
  const exportBar='<div class="export-actions"><a class="btn green" href="/export?type=leads&format=xlsx&from='+encodeURIComponent(p.since)+'&to='+encodeURIComponent(p.until)+'&account='+encodeURIComponent(selected)+'">Xuất Excel</a><a class="btn" href="/export?type=leads&format=csv&from='+encodeURIComponent(p.since)+'&to='+encodeURIComponent(p.until)+'&account='+encodeURIComponent(selected)+'">Xuất CSV</a></div>';
  const body='<div class="top"><div><h1>Khách hàng / Lead</h1><div>Một dòng cho mỗi khách × quảng cáo; các quảng cáo của cùng khách được đặt liền nhau · '+esc(p.since)+' → '+esc(p.until)+'</div></div>'+exportBar+'</div>'
    +filterForm(p,accounts,selected)
    +(errors.length?'<div class="notice error">'+errors.map(esc).join('<br>')+'</div>':'')+note
    +'<div class="stats"><div class="stat">Khách quảng cáo duy nhất<b>'+ordered.length+'</b></div><div class="stat">Có SĐT/Zalo<b>'+contactCount+'</b></div><div class="stat">Tài khoản có khách<b>'+accountCount+'</b></div><div class="stat">Chưa gắn đúng QC<b>'+Number(report.unresolvedCount||0)+'</b></div></div>'
    +'<div class="card table"><table class="aiguka-data-table lead-report-table" data-meta-messages="'+leads.length+'" data-customer-count="'+ordered.length+'"><thead><tr><th>#</th><th>Khách hàng</th><th>SĐT/Zalo</th><th>Tài khoản QC</th><th>Campaign</th><th>Ad set</th><th>Quảng cáo</th><th>Sản phẩm</th><th>Nguồn khách</th><th>Tag Pancake</th><th>Tin cuối</th><th>Giờ tài khoản</th></tr></thead><tbody>'+(rows||'<tr><td colspan="12">Không có khách quảng cáo phù hợp.</td></tr>')+'</tbody></table></div>';
  res.type("html").send(layout("Khách hàng Lead",body,"leads"));
}

`;
  source = source.slice(0, pageStart) + page + source.slice(installStart);

  const exportStart = source.indexOf("  app.get('/export',async(req,res)=>{");
  const exportEnd = source.indexOf("\n  console.log('[AIGUKA]", exportStart);
  if (exportStart < 0 || exportEnd < 0) throw new Error("LEAD_V3_EXPORT_ANCHOR_NOT_FOUND");
  const exportRoute = String.raw`  app.get('/export',async(req,res)=>{
    try{
      const p=period(req.query,'dashboard'),selected=String(req.query.account||'all')==='all'?'all':act(req.query.account);
      const type=String(req.query.type||'daily'),format=String(req.query.format||'xlsx').toLowerCase();
      let title='',headers=[],rows=[];
      if(type==='leads'){
        const report=await loadUnifiedLeadReport(p,selected);title='BÁO CÁO KHÁCH HÀNG / LEAD';
        headers=['Khách hàng','SĐT/Zalo','Tài khoản QC','Múi giờ','Campaign','Ad set','Quảng cáo','ID quảng cáo','Sản phẩm','Nguồn khách','Tag Pancake','Tin cuối','Giờ tài khoản'];
        rows=(report.leads||[]).map(x=>[x.name,(x.phones||[]).join(', ')+(x.has_zalo?' · Zalo':''),x.accountName||'',x.accountTimezone||'',x.campaignName||'',x.adsetName||'',x.adName||'',x.adId||x.ad_id||'',x.product||'',x.source_type||'Meta Business',(x.tags||[]).join(' | '),x.snippet||'',formatAccountLeadTime(x)]);
      }else{
        const d=await fetchDaily(p.since,p.until,selected);title='BÁO CÁO NGÀY';headers=['Ngày','Tài khoản QC','ID tài khoản','Thẻ / Phương thức','Chi tiêu','Hội thoại Meta'];
        rows=(d.rows||[]).map(x=>[x.date,x.accountName,x.accountId,x.paymentMethod||(x.cardLast4?'Thẻ •••• '+x.cardLast4:''),Number(x.spend||0),Number(x.messages||0)]);
      }
      const aoa=[[title],[`Khoảng ngày: ${p.since} đến ${p.until}`],[],headers,...rows];
      const filename='aiguka-'+type+'-'+p.since+'-'+p.until;
      if(format==='csv'){
        res.setHeader('content-type','text/csv; charset=utf-8');res.setHeader('content-disposition','attachment; filename="'+filename+'.csv"');
        res.send('\ufeff'+aoa.map(r=>r.map(csv).join(',')).join('\n'));return;
      }
      const ws=XLSX.utils.aoa_to_sheet(aoa),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,type==='leads'?'Khách hàng Lead':'Báo cáo ngày');
      const width=headers.map((h,i)=>({wch:Math.min(45,Math.max(String(h).length+3,...rows.slice(0,300).map(r=>String(r[i]??'').length+2)))}));ws['!cols']=width;ws['!merges']=[{s:{r:0,c:0},e:{r:0,c:Math.max(headers.length-1,0)}},{s:{r:1,c:0},e:{r:1,c:Math.max(headers.length-1,0)}}];ws['!autofilter']={ref:XLSX.utils.encode_range({r:3,c:0},{r:Math.max(3,rows.length+3),c:headers.length-1})};
      for(let c=0;c<headers.length;c++){const cell=ws[XLSX.utils.encode_cell({r:3,c})];if(cell)cell.s={fill:{fgColor:{rgb:'DCE8F5'}},font:{bold:true,color:{rgb:'203A5F'}},alignment:{horizontal:'center',vertical:'center',wrapText:true},border:{top:{style:'thin',color:{rgb:'9EB2C8'}},bottom:{style:'thin',color:{rgb:'9EB2C8'}},left:{style:'thin',color:{rgb:'9EB2C8'}},right:{style:'thin',color:{rgb:'9EB2C8'}}}}}
      if(ws.A1)ws.A1.s={font:{bold:true,sz:18,color:{rgb:'203A5F'}},alignment:{horizontal:'left'}};if(ws.A2)ws.A2.s={font:{italic:true,color:{rgb:'526A84'}}};
      const buffer=XLSX.write(wb,{type:'buffer',bookType:'xlsx',cellStyles:true});res.setHeader('content-type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('content-disposition','attachment; filename="'+filename+'.xlsx"');res.send(buffer);
    }catch(error){res.status(500).json({ok:false,error:error.message})}
  });`;
  source = source.slice(0, exportStart) + exportRoute + source.slice(exportEnd);

  const dailyExportNeedle = '<a class="btn green" href="/export?type=daily&from='+"' + p.since + '"+'&to='+"' + p.until + '"+'&account='+"' + selected + '"+'">Xuất CSV</a>';
  const dailyExportReplacement = '<div class="export-actions"><a class="btn green" href="/export?type=daily&format=xlsx&from='+"' + p.since + '"+'&to='+"' + p.until + '"+'&account='+"' + selected + '"+'">Xuất Excel</a><a class="btn" href="/export?type=daily&format=csv&from='+"' + p.since + '"+'&to='+"' + p.until + '"+'&account='+"' + selected + '"+'">Xuất CSV</a></div>';
  if (source.includes(dailyExportNeedle)) source = source.replace(dailyExportNeedle, dailyExportReplacement);

  const css = String.raw`
/* AIGUKA_TABLE_THEME_V2 */
.card.table{border:1px solid rgba(91,123,158,.34)!important;border-radius:10px!important;overflow:auto!important;background:rgba(255,255,255,.92)!important;padding:10px!important}
.card.table table,.aiguka-data-table,.daily-report-table{width:100%;border-collapse:collapse!important;border-spacing:0!important;background:rgba(255,255,255,.9)!important}
.card.table th,.card.table td,.aiguka-data-table th,.aiguka-data-table td,.daily-report-table th,.daily-report-table td{border:1px solid rgba(83,116,154,.34)!important;padding:9px 10px!important;vertical-align:top!important}
.card.table th,.aiguka-data-table th,.daily-report-table th{background:rgba(54,102,160,.14)!important;color:#203a5f!important;font-weight:700!important;white-space:normal!important}
.card.table tbody tr:nth-child(even),.aiguka-data-table tbody tr:nth-child(even),.daily-report-table tbody tr:nth-child(even){background:rgba(222,234,247,.24)!important}
.card.table tbody tr:hover,.aiguka-data-table tbody tr:hover,.daily-report-table tbody tr:hover{background:rgba(199,220,244,.34)!important}
.lead-group-cell,.daily-group-cell{background:rgba(224,235,248,.38)!important;vertical-align:middle!important}.lead-customer{min-width:210px}.lead-contact{min-width:130px}.lead-tag{display:inline-flex;margin:2px;padding:3px 7px;border-radius:999px;background:#eee7ff;color:#5a35aa;font-size:11px}.export-actions{display:flex;gap:7px;flex-wrap:wrap}.export-actions .btn{white-space:nowrap}.lead-report-table td:nth-child(11){min-width:190px}.lead-report-table td:nth-child(12){min-width:120px}
`;
  const styleEnd = source.indexOf("</style>");
  if (styleEnd < 0) throw new Error("LEAD_V3_STYLE_ANCHOR_NOT_FOUND");
  source = source.slice(0, styleEnd) + css + source.slice(styleEnd);

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`LEAD_V3_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Lead table V3, unified table theme and XLSX/CSV template installed");
}
