import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "ai-context-center-v3.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_CONTEXT_CARD_SELECTION_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Context card selection fix already active");
} else {
  source = source.replace(
    ".context-item{border:1px solid #cfdae8;border-radius:8px;padding:10px;margin-bottom:8px;cursor:pointer;background:#fbfdff}",
    ".context-item{width:100%;display:block;text-align:left;font:inherit;color:inherit;border:1px solid #cfdae8;border-radius:8px;padding:10px;margin-bottom:8px;cursor:pointer;background:#fbfdff}"
  );

  const renderPattern = /function renderList\(\)\{[\s\S]*?\}\nfunction renderSelectors\(\)/;
  const renderReplacement = `function bindContextItems(){
    document.querySelectorAll('#context-list [data-context-id]').forEach(function(row){
      row.onclick=function(event){
        event.preventDefault();
        event.stopPropagation();
        selectContext(row.getAttribute('data-context-id'));
      };
    });
  }
  function renderList(){
    var list=$('context-list');
    var rows=activeContexts().slice().sort(function(a,b){return Number(a.priority||100)-Number(b.priority||100)});
    list.innerHTML=rows.map(function(x){
      return '<button type="button" class="context-item '+(String(x.id)===String(currentId)?'active':'')+'" data-context-id="'+esc(x.id)+'"><b>'+esc(x.context_name)+'</b><div class="badges"><span class="badge '+modeClass(x.usage_mode)+'">'+esc(x.usage_mode)+'</span><span class="badge">v'+esc(x.current_version||0)+'</span><span class="badge">'+esc(D.pages.find(function(p){return String(p.page_id)===String(x.page_id)})?.page_name||'Toàn bộ Page')+'</span></div><small>'+Number((x.content||'').length).toLocaleString('vi-VN')+' ký tự</small></button>';
    }).join('')||'<div class="empty">Chưa có ngữ cảnh.</div>';
    bindContextItems();
  }
  function renderSelectors()`;
  if (!renderPattern.test(source)) throw new Error("CONTEXT_RENDER_LIST_ANCHOR_NOT_FOUND");
  source = source.replace(renderPattern, renderReplacement);

  const selectPattern = /function selectContext\(id\)\{[\s\S]*?\}\nfunction newContext\(\)/;
  const selectReplacement = `function selectContext(id){
    id=String(id||'');
    var x=D.contexts.find(function(v){return String(v.id)===id});
    if(!x){status('Không tìm thấy ngữ cảnh đã chọn. Hãy bấm Tải lại.',false);return}
    currentId=String(x.id);
    $('context-name').value=x.context_name||'';
    $('context-page').innerHTML=pageOptions(x.page_id||'');
    $('context-mode').value=x.usage_mode||'OFF';
    $('context-priority').value=x.priority||100;
    $('context-content').value=String(x.content||'');
    $('change-note').value='';
    $('current-version').textContent='Phiên bản hiện tại: v'+(x.current_version||0);
    updateCount();
    renderList();
    renderStats();
    $('history-context').value=String(x.id);
    $('test-context').value=String(x.id);
    renderHistory();
    status('Đã mở “'+(x.context_name||'Ngữ cảnh')+'” · '+Number((x.content||'').length).toLocaleString('vi-VN')+' ký tự.');
  }
  function newContext()`;
  if (!selectPattern.test(source)) throw new Error("CONTEXT_SELECT_ANCHOR_NOT_FOUND");
  source = source.replace(selectPattern, selectReplacement);

  source = source.replace(
    "$('context-list').addEventListener('click',function(e){var row=e.target.closest('[data-context]');if(row)selectContext(row.dataset.context)});",
    "$('context-list').addEventListener('click',function(e){var row=e.target.closest('[data-context-id]');if(row)selectContext(row.getAttribute('data-context-id'))});"
  );

  source = source.replace("</body>", "<!-- AIGUKA_CONTEXT_CARD_SELECTION_V1 --></body>");
  fs.writeFileSync(file, source, "utf8");

  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`CONTEXT_CARD_SELECTION_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Context cards now load the selected content reliably");
}
