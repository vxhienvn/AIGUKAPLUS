import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const h={"content-type":"application/json; charset=utf-8","cache-control":"no-store"};
const out=(x:any,s=200)=>new Response(JSON.stringify(x),{status:s,headers:h});
const t=(v:any)=>String(v??"").trim();
const n=(v:any)=>t(v).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const c=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});

async function ask(base:string,key:string,model:string,prompt:string){
  const tool={type:"function",name:"submit_revision",strict:true,description:"Nộp quyết định AI đã sửa",parameters:{type:"object",additionalProperties:false,properties:{final_reply:{type:"string"},should_send_slide:{type:"boolean"},slide_asset_ids:{type:"array",items:{type:"string"},maxItems:10},confidence:{type:"number",minimum:0,maximum:1},reason:{type:"string"}},required:["final_reply","should_send_slide","slide_asset_ids","confidence","reason"]}};
  const r=await fetch(`${base.replace(/\/$/,"")}/responses`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:JSON.stringify({model,instructions:"Bạn là AI sửa quyết định AIGUKA. Giữ đúng nhu cầu khách, tuân thủ xưng hô và số lượng ảnh được cung cấp, không bịa giá/tồn kho. Bắt buộc gọi submit_revision.",tools:[tool],tool_choice:"required",parallel_tool_calls:false,input:[{role:"user",content:[{type:"input_text",text:prompt}]}]}),signal:AbortSignal.timeout(30000)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||j?.error)throw new Error(j?.error?.message||`OPENAI_HTTP_${r.status}`);
  const call=(j.output||[]).find((x:any)=>x.type==="function_call"&&x.name==="submit_revision");
  if(!call)throw new Error("AI_REVISION_TOOL_CALL_MISSING");
  return JSON.parse(call.arguments||"{}");
}

Deno.serve(async(req)=>{
  if(req.method!=="POST")return out({ok:false,error:"METHOD_NOT_ALLOWED"},405);
  let b:any={};try{b=await req.json()}catch{return out({ok:false,error:"INVALID_JSON"},400)}
  const id=t(b.request_id);if(!id)return out({ok:false,error:"MISSING_REQUEST_ID"},400);
  const {data:q}=await c.from("v8_ai_revision_requests").select("*").eq("id",id).maybeSingle();
  if(!q||!["pending","error"].includes(q.status))return out({ok:false,error:"INVALID_REVISION"},409);
  const attempts=Number(q.attempts||0)+1;
  await c.from("v8_ai_revision_requests").update({status:"processing",attempts,started_at:new Date().toISOString(),last_error:null,updated_at:new Date().toISOString()}).eq("id",id);
  try{
    const {data:d,error:de}=await c.from("v8_ai_decisions").select("*").eq("id",q.decision_id).single();if(de||!d)throw new Error(de?.message||"DECISION_NOT_FOUND");
    const {data:cu}=d.customer_id?await c.from("v8_customers").select("display_name,gender,preferred_salutation").eq("id",d.customer_id).maybeSingle():{data:null} as any;
    let sal="anh/chị";if(t(cu?.preferred_salutation))sal=t(cu.preferred_salutation);else if(["male","nam","man"].includes(t(cu?.gender).toLowerCase()))sal="anh";else if(["female","nữ","nu","woman"].includes(t(cu?.gender).toLowerCase()))sal="chị";
    let aq=c.from("v8_drive_assets").select("id,catalog_key,product_key,file_name,sort_order").eq("is_active",true).eq("is_image",true).eq("delivery_status","verified").order("sort_order").limit(10);
    if(t(d.catalog_key))aq=aq.eq("catalog_key",t(d.catalog_key));else if(t(d.product_scope))aq=aq.or(`catalog_key.eq.${t(d.product_scope)},product_key.eq.${t(d.product_scope)}`);
    const {data:assets,error:ae}=await aq;if(ae)throw ae;
    const list=assets||[],allowed=new Set(list.map((x:any)=>String(x.id))),min=d.should_send_slide?Math.min(5,list.length):0;
    const {data:p}=await c.from("v8_ai_providers").select("*").eq("provider_key",d.provider_key||"openai").maybeSingle();if(!p?.is_enabled)throw new Error("AI_PROVIDER_DISABLED");
    const secret=t(p.api_key_secret_name||"OPENAI_API_KEY"),key=t(Deno.env.get(secret));if(!key)throw new Error("MISSING_AI_SECRET");
    const model=t(d.model_name||p.model_name),base=t(p.base_url||"https://api.openai.com/v1");
    const source=JSON.stringify({customer:{name:cu?.display_name||null,required_salutation:sal},original:{final_reply:d.final_reply,should_send_slide:d.should_send_slide,slide_asset_ids:d.slide_asset_ids,goal:d.customer_goal,intent:d.intent_type},blocking:q.reasons,verified_assets:list,mandatory:{salutation:sal!=="anh/chị"?`không dùng anh/chị; dùng ${sal}`:"có thể dùng anh/chị",slides:list.length>=5?"nếu gửi ảnh phải chọn 5-10 id":"nếu gửi ảnh chọn toàn bộ ảnh xác minh",price:"không bịa số giá",inventory:"không khẳng định còn hàng/giao ngay"}});
    let chosen:any=null,last="";
    for(let i=0;i<2&&!chosen;i++){
      const r=await ask(base,key,model,i?`${source}\nLần trước sai: ${last}`:source);
      const ids=[...new Set((r.slide_asset_ids||[]).map(t).filter(Boolean))] as string[];
      const badId=ids.some(x=>!allowed.has(x)),badCount=!!r.should_send_slide&&(ids.length<min||ids.length>10),badSal=sal!=="anh/chị"&&n(r.final_reply).includes("anh chi");
      if(badId||badCount||badSal||!t(r.final_reply)){last=JSON.stringify({badId,badCount,badSal,count:ids.length,min});continue}
      chosen={...r,slide_asset_ids:ids};
    }
    if(!chosen)throw new Error(`AI_REVISION_VALIDATION_FAILED_${last}`);
    const {data:applied,error:pe}=await c.rpc("v8_apply_ai_revision",{p_request_id:id,p_final_reply:t(chosen.final_reply),p_slide_asset_ids:chosen.slide_asset_ids,p_should_send_slide:!!chosen.should_send_slide,p_revision_reason:t(chosen.reason),p_confidence:Number(chosen.confidence||d.confidence||.8),p_model_name:model});if(pe)throw pe;
    return out({ok:true,request_id:id,applied});
  }catch(e:any){const m=t(e?.message||e).slice(0,1000);await c.from("v8_ai_revision_requests").update({status:attempts>=Number(q.max_attempts||3)?"failed":"error",last_error:m,available_at:new Date(Date.now()+5000).toISOString(),updated_at:new Date().toISOString()}).eq("id",id);return out({ok:false,error:m},500)}
});