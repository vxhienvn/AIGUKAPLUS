import fs from "node:fs";

const file = "learning-admin-v2-client.js";
let source = fs.readFileSync(file, "utf8");
const start = source.indexOf("function renderPrompts(){");
const end = source.indexOf("function newPrompt(){", start);
if (start < 0 || end < 0) throw new Error("LEARNING_PROMPT_FILTER_ANCHOR_NOT_FOUND");
const replacement = `function renderPrompts(){
  const q=String($('prompt-search')?.value||'').toLowerCase();
  const group=$('prompt-group-filter')?.value||'';
  const type=$('prompt-type-filter')?.value||'';
  const rows=promptBranches.filter(x=>(!type||x.source_type===type)&&(!group||x.prompt_group_key===group)&&(!q||[x.branch_name,x.trigger_description,x.instruction_text,x.example_customer_message,x.example_good_reply].join(' ').toLowerCase().includes(q)));
  $('prompt-list').innerHTML=rows.map(x=>'<div class="prompt-row '+(x.is_active?'':'inactive')+'" onclick="editPrompt(\\''+x.id+'\\')"><b>'+esc(x.branch_name)+'</b><br><span class="badge '+(x.source_type==='reply_template'?'template':'learn')+'">'+esc(x.source_type==='reply_template'?'Mẫu trả lời tự động':'Prompt / Nhánh học')+'</span> <span class="badge">'+esc(promptGroups.find(g=>g.group_key===x.prompt_group_key)?.group_name||x.prompt_group_key||'Chưa nhóm')+'</span> <span class="badge">Ưu tiên '+esc(x.priority)+'</span><div>'+esc(x.instruction_text||'')+'</div></div>').join('')||'<div class="muted">Không có nội dung phù hợp bộ lọc.</div>';
}
`;
source = source.slice(0, start) + replacement + source.slice(end);
source = source.replace("$('prompt-form-title').textContent='Thêm nhánh Prompt'", "$('prompt-form-title').textContent='Thêm Prompt / nhánh học'");
source = source.replace("x.source_type==='reply_template'?'Sửa Prompt nền':'Sửa nhánh Prompt'", "x.source_type==='reply_template'?'Sửa mẫu trả lời tự động':'Sửa Prompt / nhánh học'");
source = source.replace("setStatus('Đang tải Prompt…')", "setStatus('Đang tải Prompt và mẫu trả lời…')");
source = source.replace("setStatus('Đã tải '+promptBranches.length+' Prompt đang quản lý')", "setStatus('Đã tải '+promptBranches.length+' mục đang quản lý')");
fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] Prompt branches and automatic reply templates separated in UI");