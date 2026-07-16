const VERSION=process.env.META_GRAPH_VERSION||"v23.0";
const rootToken=()=>process.env.META_ACCESS_TOKEN||process.env.META_USER_ACCESS_TOKEN||process.env.FACEBOOK_USER_ACCESS_TOKEN||"";
const cache={rows:[],time:0};
async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(30000),cache:"no-store"});const j=await r.json().catch(()=>({}));if(!r.ok||j.error)throw Error(j.error?.message||"META_HTTP_"+r.status);return j}
async function pages(url,max=15){const out=[];let next=url,n=0;while(next&&n++<max){const j=await json(next);out.push(...(j.data||[]));next=j.paging?.next||""}return out}
export async function fetchMetaBusinessRows(limit=2000){
  if(cache.rows.length&&Date.now()-cache.time<180000)return cache.rows;
  const token=rootToken();if(!token)return [];
  const accountUrl="https://graph.facebook.com/"+VERSION+"/me/accounts?fields=id,name,access_token&limit=100&access_token="+encodeURIComponent(token);
  const pagesList=await pages(accountUrl,5);
  const batches=await Promise.all(pagesList.map(async page=>{
    try{
      const pt=page.access_token||token;
      const fields="id,updated_time,participants,messages.limit(100){id,message,from,created_time,attachments}";
      const url="https://graph.facebook.com/"+VERSION+"/"+encodeURIComponent(page.id)+"/conversations?fields="+encodeURIComponent(fields)+"&limit=100&access_token="+encodeURIComponent(pt);
      const conversations=await pages(url,10),rows=[];
      for(const conv of conversations){
        const customer=(conv.participants?.data||[]).find(x=>String(x.id)!==String(page.id))||{};
        let messages=[...(conv.messages?.data||[])],next=conv.messages?.paging?.next||"",n=0;
        while(next&&n++<5&&messages.length<500){const part=await json(next);messages.push(...(part.data||[]));next=part.paging?.next||""}
        for(const m of messages){
          if(String(m.from?.id||"")===String(page.id))continue;
          rows.push({name:m.from?.name||customer.name||"Không rõ tên",customer_id:String(m.from?.id||customer.id||""),conversation_id:String(conv.id||"")+":"+String(m.id||""),meta_conversation_id:String(conv.id||""),meta_message_id:String(m.id||""),page_id:String(page.id),page_name:page.name||"",updated_at:m.created_time,last_customer_message_at:m.created_time,last_message_is_customer:true,source_type:"Tin nhắn",snippet:String(m.message||"")||((m.attachments?.data||[]).length?"[Tệp đính kèm]":""),phones:[],tags:[],ad_ids:[],message_count:1,from_meta_business:true,date_verified:true});
        }
      }
      return rows;
    }catch(e){console.error("[AIGUKA Meta Business page]",page.name||page.id,e.message);return []}
  }));
  cache.rows=batches.flat().sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at)).slice(0,limit);cache.time=Date.now();return cache.rows;
}
