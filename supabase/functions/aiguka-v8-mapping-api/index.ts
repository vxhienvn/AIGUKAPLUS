import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type J = Record<string, any>;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-aiguka-admin-secret",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
  "Cache-Control": "no-store",
};
const out = (body:J,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"content-type":"application/json; charset=utf-8"}});
const text=(v:any)=>String(v??"").trim();
function requireAdmin(req:Request){
  const configured=text(Deno.env.get("AIGUKA_V8_ADMIN_SECRET"));
  if(!configured) throw new Error("admin_secret_not_configured");
  if(req.headers.get("x-aiguka-admin-secret")!==configured) throw new Error("unauthorized");
  return configured;
}
function db(adminSecret:string){
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key) throw new Error("missing_supabase_env");
  return createClient(url,key,{auth:{persistSession:false},global:{headers:{"x-aiguka-admin-secret":adminSecret}}});
}
async function body(req:Request){try{return await req.json()}catch{throw new Error("invalid_json")}}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
  const u=new URL(req.url),action=u.searchParams.get("action")||"health";
  if(action==="health") return out({ok:true,service:"aiguka-v8-mapping-api",version:1,resolver:"unified_mapping_v1"});
  let secret="";
  try{secret=requireAdmin(req)}catch(e){const m=e instanceof Error?e.message:String(e);return out({ok:false,error:m},m==="unauthorized"?401:503)}
  const c=db(secret);
  try{
    if(req.method==="GET"&&action==="overview"){
      const {data,error}=await c.rpc("v8_admin_mapping_overview"); if(error)throw error;
      return out({ok:true,data});
    }
    if(req.method==="GET"&&action==="regression"){
      const {data,error}=await c.rpc("v8_mapping_regression_test"); if(error)throw error;
      return out({ok:true,data});
    }
    if(req.method==="POST"&&action==="test"){
      const b=await body(req); const {data,error}=await c.rpc("v8_admin_test_unified_mapping",{p_payload:{...b,actor:"mapping_ui"}}); if(error)throw error;
      return out({ok:true,data});
    }
    if(req.method==="POST"&&action==="save_ad"){
      const b=await body(req); const {data,error}=await c.rpc("v8_admin_save_ad_mapping",{p_payload:{...b,actor:"mapping_ui"}}); if(error)throw error;
      return out({ok:true,data});
    }
    if(req.method==="POST"&&action==="disable_ad"){
      const b=await body(req); const {data,error}=await c.rpc("v8_admin_disable_ad_mapping",{p_ad_id:text(b.ad_id),p_actor:"mapping_ui"}); if(error)throw error;
      return out({ok:true,data});
    }
    if(req.method==="POST"&&action==="runtime"){
      const b=await body(req); const {data,error}=await c.rpc("v8_admin_set_mapping_runtime",{p_payload:{...b,actor:"mapping_ui"}}); if(error)throw error;
      return out({ok:true,data});
    }
    if(req.method==="POST"&&action==="save_slide"){
      const b=await body(req); const {data,error}=await c.rpc("v8_admin_save_slide_mapping",{p_payload:{...b,actor:"mapping_ui"}}); if(error)throw error;
      return out({ok:true,data});
    }
    if(req.method==="POST"&&action==="sync"){
      const b=await body(req); const {data,error}=await c.rpc("v8_request_drive_sync",{p_product_key:text(b.product_key)||null}); if(error)throw error;
      return out({ok:true,affected:data});
    }
    return out({ok:false,error:"unknown_action"},404);
  }catch(e){return out({ok:false,error:e instanceof Error?e.message:String(e)},500)}
});
