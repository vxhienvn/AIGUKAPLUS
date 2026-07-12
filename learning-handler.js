export function installLearningRoutes(app,{supabaseUrl,publishableKey}){
  const headers=()=>({apikey:publishableKey,authorization:`Bearer ${publishableKey}`,"content-type":"application/json","x-aiguka-railway-test":"enabled","x-aiguka-admin-secret":"AIGUKA_RAILWAY_TEST_MODE"});
  async function rpc(name,args={}){
    if(!publishableKey)throw Error("MISSING_SUPABASE_PUBLISHABLE_KEY");
    const r=await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`,{method:"POST",headers:headers(),body:JSON.stringify(args),signal:AbortSignal.timeout(60000),cache:"no-store"});
    const t=await r.text();let j;try{j=JSON.parse(t)}catch{j={raw:t.slice(0,500)}}
    if(!r.ok)throw Error(j?.message||j?.error||`RPC_HTTP_${r.status}`);return j;
  }
  async function body(req){let raw="";for await(const chunk of req){raw+=chunk;if(raw.length>2_000_000)throw Error("BODY_TOO_LARGE")}try{return raw?JSON.parse(raw):{}}catch{return {}}}
  app.get("/functions/v1/aiguka-v8-admin-v14-api",async(req,res)=>{
    const action=String(req.query.action||"health").toLowerCase();
    try{
      if(action==="health")return res.json({ok:true,service:"aiguka-v8-learning-railway",version:3});
      if(action==="conversation_list"){
        const d=await rpc("v8_learning_conversation_list_test",{p_search:String(req.query.search||"")||null,p_limit:Math.min(Math.max(Number(req.query.limit||50),1),500),p_offset:Math.max(Number(req.query.offset||0),0)});
        return res.json({ok:true,...d});
      }
      if(action==="conversation_detail"){
        const d=await rpc("v8_learning_conversation_detail_test",{p_page_id:String(req.query.page_id||""),p_sender_id:String(req.query.sender_id||"")});
        return res.json({ok:true,data:d});
      }
      return res.status(404).json({ok:false,error:"unknown_route"});
    }catch(error){return res.status(500).json({ok:false,error:error instanceof Error?error.message:String(error)})}
  });
  app.post("/functions/v1/aiguka-v8-admin-v14-api",async(req,res)=>{
    const action=String(req.query.action||"").toLowerCase();
    try{
      const b=await body(req);
      if(action==="set_salutation"){
        const d=await rpc("v8_admin_set_salutation",{p_customer_id:b.customer_id,p_preferred_salutation:b.preferred_salutation||null,p_gender:b.gender||null});
        return res.json({ok:true,data:d});
      }
      if(action==="save_good_conversation"){
        const d=await rpc("v8_save_good_conversation",{p_page_id:String(b.page_id||""),p_sender_id:String(b.sender_id||""),p_created_by:b.created_by||"admin_learning_railway"});
        return res.json({ok:true,data:d});
      }
      if(action==="sync_profile"||action==="sync_history"){
        const d=await rpc("v8_request_meta_sync",{p_scope:action==="sync_history"?"conversation":"profile",p_limit:1,p_page_id:String(b.page_id||""),p_sender_id:String(b.sender_id||""),p_force:true,p_stale_minutes:0,p_requested_by:"admin_learning_railway"});
        return res.json({ok:true,data:{queued:true,request:d,message:"Đã đưa yêu cầu đồng bộ vào hàng đợi Meta"}});
      }
      return res.status(404).json({ok:false,error:"unknown_route"});
    }catch(error){return res.status(500).json({ok:false,error:error instanceof Error?error.message:String(error)})}
  });
}