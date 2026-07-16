const GRAPH_VERSION=process.env.META_GRAPH_VERSION||"v23.0";
const token=()=>process.env.META_ACCESS_TOKEN||process.env.META_USER_ACCESS_TOKEN||process.env.FACEBOOK_USER_ACCESS_TOKEN||"";
const clean=v=>String(v??"").trim();
function normalize(row,pageId,senderId){
  const fromId=clean(row.from?.id),outbound=fromId===String(pageId);
  const text=clean(row.message);
  return {id:"meta:"+clean(row.id||row.created_time+"|"+fromId+"|"+text),message_id:clean(row.id),direction:outbound?"outbound":"inbound",role:outbound?"page":"customer",actor_type:outbound?"page_or_system":"customer",actor_name:clean(row.from?.name)||(outbound?"Trang/nhân viên/hệ thống":"Khách hàng"),source_system:"meta_business_history",is_automatic:false,message_text:text,text,attachments:row.attachments?.data||[],sent_at:row.created_time,created_at:row.created_time,raw_payload:row,source_detail:{source:"meta_graph_conversation",sender_id:senderId}};
}
async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(30000),cache:"no-store"});const t=await r.text();let j;try{j=JSON.parse(t)}catch{j={raw:t.slice(0,500)}}if(!r.ok||j.error)throw Error(j.error?.message||j.message||"META_HTTP_"+r.status);return j}
export async function fetchMetaBusinessConversation({pageId,senderId}={}){
  const access=token();if(!access||!pageId||!senderId)return {ok:false,messages:[],reason:"missing_meta_context"};
  const base="https://graph.facebook.com/"+GRAPH_VERSION+"/"+encodeURIComponent(pageId)+"/conversations";
  const fields="id,updated_time,messages.limit(100){id,message,from,to,created_time,attachments}";
  const first=await json(base+"?user_id="+encodeURIComponent(senderId)+"&fields="+encodeURIComponent(fields)+"&limit=5&access_token="+encodeURIComponent(access));
  const conv=(first.data||[])[0];if(!conv)return {ok:false,messages:[],reason:"conversation_not_found"};
  let rows=[...(conv.messages?.data||[])],next=conv.messages?.paging?.next||"",pages=0;
  while(next&&pages++<10){const part=await json(next);rows.push(...(part.data||[]));next=part.paging?.next||""}
  const seen=new Map();for(const row of rows){const m=normalize(row,pageId,senderId);if(m.message_id&&!seen.has(m.message_id))seen.set(m.message_id,m)}
  const messages=[...seen.values()].sort((a,b)=>new Date(a.sent_at||0)-new Date(b.sent_at||0));
  return {ok:messages.length>0,messages,conversation_id:clean(conv.id),count:messages.length};
}
