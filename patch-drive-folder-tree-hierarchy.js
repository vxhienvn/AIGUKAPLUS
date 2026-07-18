import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "drive-slide-manager-v4.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_DRIVE_FOLDER_TREE_HIERARCHY_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Drive hierarchical folder tree already installed");
} else {
  const stateNeedle = "folderStack=[],folderTree=[],selectedFolders=[],draftFolders=[];";
  if (!source.includes(stateNeedle)) throw new Error("DRIVE_TREE_STATE_ANCHOR_NOT_FOUND");
  source = source.replace(
    stateNeedle,
    "folderStack=[],folderTree=[],selectedFolders=[],draftFolders=[],collapsedFolders=new Set();",
  );

  const cssAnchor = "@media(max-width:900px)";
  if (!source.includes(cssAnchor)) throw new Error("DRIVE_TREE_CSS_ANCHOR_NOT_FOUND");
  const css = `.folder-tree-node{position:relative}.folder-tree-row{--tree-level:0;display:grid;grid-template-columns:28px 26px minmax(0,1fr) auto;align-items:center;gap:6px;min-height:46px;padding:5px 8px 5px calc(8px + var(--tree-level)*24px);border-bottom:1px solid #dce5f0;background:#fff}.folder-tree-row:hover{background:#f3f7fc}.folder-tree-row.folder-root-row{background:#eaf2fd;border:1px solid #b8cce5;border-radius:7px;margin-bottom:5px;font-size:14px}.folder-tree-row.folder-selected{background:#e7f1ff}.folder-toggle{width:26px;height:26px;padding:0;border:0;background:transparent;color:#355a84;font-size:16px;font-weight:700}.folder-toggle.empty{cursor:default;color:#a9b8c8}.folder-check{width:16px!important;height:16px;margin:0}.folder-label{display:flex!important;align-items:flex-start;gap:8px;margin:0!important;cursor:pointer;min-width:0}.folder-label-main{min-width:0}.folder-label-main b{display:block;color:#172c49}.folder-path{display:block;margin-top:2px;color:#718096;font-size:11px;white-space:normal}.folder-child-count{font-size:11px;color:#526d8c;background:#edf3fa;border-radius:999px;padding:3px 7px;white-space:nowrap}.folder-children{position:relative}.folder-children:before{content:"";position:absolute;left:calc(21px + var(--parent-level,0)*24px);top:0;bottom:0;border-left:1px dashed #b9c9dc}.folder-tree-empty{padding:22px;text-align:center;color:#667085}.folder-tree-summary{margin:7px 0;color:#526d8c;font-size:12px}.folder-option{display:none!important}`;
  source = source.replace(cssAnchor, `${css}${cssAnchor}`);

  const actionNeedle = '<div class="actions"><button id="select-root-folder">Chọn thư mục gốc</button><button id="unselect-all-folders">Bỏ chọn tất cả</button><button id="apply-folders" class="primary">Áp dụng</button></div>';
  if (!source.includes(actionNeedle)) throw new Error("DRIVE_TREE_ACTIONS_ANCHOR_NOT_FOUND");
  source = source.replace(
    actionNeedle,
    '<div class="actions"><button id="select-root-folder">Chọn thư mục gốc</button><button id="expand-all-folders">Mở tất cả</button><button id="collapse-folders">Thu gọn</button><button id="unselect-all-folders">Bỏ chọn tất cả</button><button id="apply-folders" class="primary">Áp dụng</button></div><div id="folder-tree-summary" class="folder-tree-summary"></div>',
  );

  const drawStart = source.indexOf("function drawTree(){");
  const previewStart = source.indexOf("function preview(){", drawStart);
  if (drawStart < 0 || previewStart < 0) throw new Error("DRIVE_TREE_DRAW_ANCHOR_NOT_FOUND");
  const drawTree = `function drawTree(){
    const query=$('folder-search').value.trim().toLowerCase();
    const byParent=new Map();
    const byId=new Map(folderTree.map(folder=>[String(folder.id),folder]));
    for(const folder of folderTree){
      const parent=folder.parent_id==null?'__ROOT__':String(folder.parent_id);
      if(!byParent.has(parent))byParent.set(parent,[]);
      byParent.get(parent).push(folder);
    }
    for(const children of byParent.values())children.sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'vi'));
    const root=folderTree.find(folder=>folder.parent_id==null)||folderTree[0];
    const selectedIds=new Set(draftFolders.map(folder=>String(folder.id)));
    const matchCache=new Map();
    const subtreeMatches=folder=>{
      const id=String(folder.id);
      if(matchCache.has(id))return matchCache.get(id);
      const self=!query||String(folder.name||'').toLowerCase().includes(query)||String(folder.path||'').toLowerCase().includes(query);
      const children=byParent.get(id)||[];
      const matched=self||children.some(subtreeMatches);
      matchCache.set(id,matched);
      return matched;
    };
    const renderNode=(folder,level,isRoot=false)=>{
      if(query&&!subtreeMatches(folder))return '';
      const id=String(folder.id);
      const children=(byParent.get(id)||[]).filter(child=>!query||subtreeMatches(child));
      const open=query||!collapsedFolders.has(id);
      const selected=selectedIds.has(id);
      const toggle=children.length
        ? '<button type="button" class="folder-toggle" data-toggle-folder="'+E(id)+'" title="'+(open?'Thu gọn':'Mở thư mục con')+'">'+(open?'▾':'▸')+'</button>'
        : '<span class="folder-toggle empty">·</span>';
      const row='<div class="folder-tree-row '+(isRoot?'folder-root-row ':'')+(selected?'folder-selected':'')+'" style="--tree-level:'+level+'">'
        +toggle
        +'<input class="folder-check" type="checkbox" data-folder-id="'+E(id)+'" '+(selected?'checked':'')+'>'
        +'<label class="folder-label" data-folder-label="'+E(id)+'"><span>'+(isRoot?'📦':'📁')+'</span><span class="folder-label-main"><b>'+E(folder.name)+'</b><small class="folder-path">'+E(folder.path||folder.name)+'</small></span></label>'
        +(children.length?'<span class="folder-child-count">'+children.length+' thư mục con</span>':'<span></span>')
        +'</div>';
      const childHtml=children.map(child=>renderNode(child,level+1,false)).join('');
      return '<div class="folder-tree-node" data-tree-node="'+E(id)+'">'+row+'<div class="folder-children '+(open?'':'hide')+'" style="--parent-level:'+level+'">'+childHtml+'</div></div>';
    };
    let html='';
    if(root)html=renderNode(root,0,true);
    else html=(byParent.get('__ROOT__')||[]).map(folder=>renderNode(folder,0,true)).join('');
    $('folder-tree').innerHTML=html||'<div class="folder-tree-empty">Không tìm thấy thư mục phù hợp.</div>';
    $('folder-tree-summary').textContent='Đã chọn '+draftFolders.length+' thư mục · '+folderTree.length+' thư mục trong cây.';
  }
  `;
  source = source.slice(0, drawStart) + drawTree + source.slice(previewStart);

  const pickerNeedle = "if(!folderTree.length)folderTree=(await api('/drive/tree')).folders||[];drawTree()";
  if (!source.includes(pickerNeedle)) throw new Error("DRIVE_TREE_PICKER_ANCHOR_NOT_FOUND");
  source = source.replace(
    pickerNeedle,
    "if(!folderTree.length){folderTree=(await api('/drive/tree')).folders||[];const parentIds=new Set(folderTree.map(x=>String(x.parent_id||'')));collapsedFolders=new Set(folderTree.filter(x=>Number(x.depth)>=2&&parentIds.has(String(x.id))).map(x=>String(x.id)))}drawTree()",
  );

  const eventsNeedle = "$('folder-search').oninput=drawTree;$('folder-tree').onchange=e=>{const b=e.target.closest('[data-folder-id]');if(!b)return;const f=folderTree.find(x=>x.id===b.dataset.folderId);if(b.checked){if(f&&!draftFolders.some(x=>x.id===f.id))draftFolders.push(f)}else draftFolders=draftFolders.filter(x=>x.id!==b.dataset.folderId)};";
  if (!source.includes(eventsNeedle)) throw new Error("DRIVE_TREE_EVENTS_ANCHOR_NOT_FOUND");
  const eventsReplacement = "$('folder-search').oninput=drawTree;$('folder-tree').onclick=e=>{const toggle=e.target.closest('[data-toggle-folder]');if(toggle){const id=String(toggle.dataset.toggleFolder);if(collapsedFolders.has(id))collapsedFolders.delete(id);else collapsedFolders.add(id);drawTree();return}const label=e.target.closest('[data-folder-label]');if(label){const box=$('folder-tree').querySelector('[data-folder-id=\"'+CSS.escape(String(label.dataset.folderLabel))+'\"]');if(box){box.checked=!box.checked;box.dispatchEvent(new Event('change',{bubbles:true}))}}};$('folder-tree').onchange=e=>{const b=e.target.closest('[data-folder-id]');if(!b)return;const f=folderTree.find(x=>String(x.id)===String(b.dataset.folderId));if(b.checked){if(f&&!draftFolders.some(x=>String(x.id)===String(f.id)))draftFolders.push(f)}else draftFolders=draftFolders.filter(x=>String(x.id)!==String(b.dataset.folderId));drawTree()};";
  source = source.replace(eventsNeedle, eventsReplacement);

  const buttonNeedle = "$('select-root-folder').onclick=()=>{draftFolders=folderTree.filter(x=>x.depth===0);drawTree()};$('unselect-all-folders').onclick=()=>{draftFolders=[];drawTree()};";
  if (!source.includes(buttonNeedle)) throw new Error("DRIVE_TREE_BUTTONS_ANCHOR_NOT_FOUND");
  source = source.replace(
    buttonNeedle,
    "$('select-root-folder').onclick=()=>{draftFolders=folderTree.filter(x=>x.depth===0);collapsedFolders.clear();drawTree()};$('expand-all-folders').onclick=()=>{collapsedFolders.clear();drawTree()};$('collapse-folders').onclick=()=>{const parentIds=new Set(folderTree.map(x=>String(x.parent_id||'')));collapsedFolders=new Set(folderTree.filter(x=>Number(x.depth)>=1&&parentIds.has(String(x.id))).map(x=>String(x.id)));drawTree()};$('unselect-all-folders').onclick=()=>{draftFolders=[];drawTree()};",
  );

  source = source.replace("</body></html>`;", `<!-- ${marker} --></body></html>\`;`);
  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`DRIVE_TREE_HIERARCHY_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Drive folder picker now renders a collapsible hierarchical tree");
}
