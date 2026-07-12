export function patchLearningUi(html){
  const extra=`<style>
#aiguka_sources{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid #ddd}
#aiguka_sources a{padding:9px 11px;border:1px solid #bbb;border-radius:8px;background:#fff;color:#174ea6;text-decoration:none;font-weight:700}
.aiguka_tag{display:inline-block;padding:4px 8px;margin:2px;border-radius:999px;background:#ede9fe;color:#5b21b6;font-size:12px}
</style><script>(function(){
let previous='';
function data(){try{return typeof S!=='undefined'?S.current:null}catch{return null}}
function show(){const d=data(),head=document.getElementById('head');if(!d||!head)return;const page=String(d.page_id||''),sender=String(d.sender_id||''),conv=String(d.pancake_conversation_id||d.conversation_id||''),key=page+'|'+sender+'|'+conv;if(key===previous&&document.getElementById('aiguka_sources'))return;previous=key;document.getElementById('aiguka_sources')?.remove();const box=document.createElement('div');box.id='aiguka_sources';const meta=document.createElement('a');meta.target='_blank';meta.href=d.meta_business_url||('https://business.facebook.com/latest/inbox/all?asset_id='+encodeURIComponent(page)+'&selected_item_id='+encodeURIComponent(sender));meta.textContent='Xem trên Meta Business';box.appendChild(meta);const pan=document.createElement('a');pan.target='_blank';pan.href=d.pancake_url||'https://pancake.vn';pan.textContent='Mở Pancake · mã '+conv;box.appendChild(pan);const tags=(Array.isArray(d.pancake_tags)?d.pancake_tags:[]).map(x=>x&&typeof x==='object'?(x.text||x.name||''):String(x||'')).filter(Boolean);if(tags.length){const w=document.createElement('div');w.style.flexBasis='100%';w.innerHTML='<b>Tag Pancake:</b> '+tags.map(t=>'<span class="aiguka_tag">'+t+'</span>').join('');box.appendChild(w)}head.appendChild(box)}
new MutationObserver(show).observe(document.documentElement,{childList:true,subtree:true});setInterval(show,900);setTimeout(show,400);
})();</script>`;
  return /<\/body>/i.test(html)?html.replace(/<\/body>/i,extra+'</body>'):html+extra;
}
