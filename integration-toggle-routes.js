const cleanUrl=v=>String(v||"").replace(/\/$/,"");
export function installIntegrationToggleRoutes(app){
  const url=cleanUrl(process.env.SUPABASE_URL);
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY||"";
  const headers={apikey:key,authorization:"Bearer "+key,"content-type":"application/json"};
  app.get("/api/integrations/pancake",async(_req,res)=>{
    try{
      const r=await fetch(url+"/rest/v1/v8_integration_runtime?integration_key=eq.pancake&select=integration_key,connection_enabled,message_sync_enabled,status&limit=1",{headers,cache:"no-store"});
      const rows=await r.json(); if(!r.ok)throw Error(rows?.message||"HTTP_"+r.status);
      res.json({ok:true,data:rows[0]||{integration_key:"pancake",connection_enabled:true,message_sync_enabled:true}});
    }catch(e){res.status(500).json({ok:false,error:e.message})}
  });
  app.post("/api/integrations/pancake",async(req,res)=>{
    try{
      const body=req.body||{};const patch={updated_at:new Date().toISOString()};
      if(typeof body.connection_enabled==="boolean")patch.connection_enabled=body.connection_enabled;
      if(typeof body.message_sync_enabled==="boolean")patch.message_sync_enabled=body.message_sync_enabled;
      const r=await fetch(url+"/rest/v1/v8_integration_runtime?integration_key=eq.pancake",{method:"PATCH",headers:{...headers,Prefer:"return=representation"},body:JSON.stringify(patch)});
      const rows=await r.json();if(!r.ok)throw Error(rows?.message||"HTTP_"+r.status);
      res.json({ok:true,data:rows[0]||patch});
    }catch(e){res.status(500).json({ok:false,error:e.message})}
  });
}
