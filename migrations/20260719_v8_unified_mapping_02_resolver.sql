create or replace function public.v8_resolve_unified_mapping(
 p_page_id text,p_sender_id text,p_message_text text,p_referral jsonb default '{}'::jsonb,p_before timestamptz default now()
) returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $f$
declare
 cfg public.v8_mapping_runtime%rowtype; d record; g jsonb; a public.ad_mappings%rowtype;
 eg text; ec text; er text; ef numeric:=0;
 rg text; rc text; rr text; rf numeric:=0;
 ag text; ac text; ar text; af numeric:=0; asrc text;
 sg text; sc text; sr text; src text:='none'; conf numeric:=0;
 adid text:=nullif(btrim(coalesce(p_referral->>'ad_id','')),'');
 adtitle text:=nullif(btrim(coalesce(p_referral#>>'{ads_context_data,ad_title}',p_referral->>'ad_title','')),'');
 nk jsonb; folders text[]:=array[]::text[]; sm record; st text; conflict boolean:=false; clarify boolean:=false; applyit boolean:=false; assets integer:=0;
begin
 select * into cfg from public.v8_mapping_runtime where page_id=p_page_id;
 if cfg.page_id is null then cfg.mode:='OBSERVE';cfg.use_ad_mapping:=true;cfg.use_recent_context:=true;cfg.use_slide_mapping:=true;cfg.minimum_apply_confidence:=0.78;cfg.recent_context_minutes:=60;end if;
 select * into d from public.v8_detect_catalog_smart(p_message_text) limit 1;
 g:=public.v8_resolve_group_context(p_message_text);
 if d.catalog_key is not null then ec:=d.catalog_key;er:=d.root_product_key;ef:=coalesce(d.confidence,0);select group_key into eg from public.v8_resolve_business_group(ec) limit 1;
 elsif g->>'status'='resolved' then eg:=g#>>'{group,group_key}';ef:=0.90;end if;
 if cfg.use_recent_context then
  select q.payload->'mapping_resolution'->>'group_key',q.payload->'mapping_resolution'->>'catalog_key',q.payload->'mapping_resolution'->>'root_product_key',coalesce((q.payload->'mapping_resolution'->>'confidence')::numeric,0.84)
  into rg,rc,rr,rf from public.v8_processing_queue q join public.v8_messages_raw m on m.page_id=q.page_id and m.message_id=q.message_id
  where q.page_id=p_page_id and q.sender_id=p_sender_id and q.status='done' and m.direction='inbound' and m.sent_at<coalesce(p_before,now()) and m.sent_at>=coalesce(p_before,now())-make_interval(mins=>coalesce(cfg.recent_context_minutes,60)) and q.payload?'mapping_resolution'
  order by m.sent_at desc limit 1;
 end if;
 if cfg.use_ad_mapping and adid is not null then
  select * into a from public.ad_mappings where ad_id=adid and coalesce(enabled,true) and coalesce(is_active,true) limit 1;
  if a.ad_id is not null then
   nk:=public.v8_mapping_normalize_key(coalesce(nullif(a.product_item_key,''),nullif(a.product_group,''),nullif(a.slide_key,''),nullif(a.product_type,'')));
   ag:=nk->>'group_key';ac:=nk->>'catalog_key';ar:=nk->>'root_product_key';asrc:='ad_mapping';af:=case when ac is not null then .88 when ag is not null then .78 else 0 end;
   folders:=public.v8_mapping_folder_ids(coalesce(nullif(a.selected_folders,'[]'::jsonb),nullif(a.drive_folders,'[]'::jsonb),'[]'::jsonb));
  end if;
 end if;
 if cfg.use_ad_mapping and asrc is null and adtitle is not null then
  select * into d from public.v8_detect_catalog_smart(adtitle) limit 1;g:=public.v8_resolve_group_context(adtitle);
  if d.catalog_key is not null and coalesce(d.confidence,0)>=.62 then ac:=d.catalog_key;ar:=d.root_product_key;select group_key into ag from public.v8_resolve_business_group(ac) limit 1;af:=least(.76,coalesce(d.confidence,0));asrc:='ad_title';
  elsif g->>'status'='resolved' then ag:=g#>>'{group,group_key}';af:=.68;asrc:='ad_title_group';end if;
 end if;
 if ec is not null and ef>=.62 then sg:=eg;sc:=ec;sr:=er;src:='customer_explicit';conf:=ef;conflict:=coalesce(ac,ag) is not null and coalesce(ac,ag)<>coalesce(ec,eg);
 elsif eg is not null and ef>=.80 then sg:=eg;src:='customer_group';conf:=ef;conflict:=ag is not null and ag<>eg;
 elsif rc is not null then sg:=rg;sc:=rc;sr:=rr;src:='recent_context';conf:=greatest(.84,rf);
 elsif ac is not null then sg:=ag;sc:=ac;sr:=ar;src:=asrc;conf:=af;
 elsif rg is not null then sg:=rg;src:='recent_group';conf:=.80;
 elsif ag is not null then sg:=ag;src:=asrc;conf:=af;end if;
 if sc is not null and sg is null then select group_key into sg from public.v8_resolve_business_group(sc) limit 1;end if;
 if sr is null and sc is not null then select root_product_key into sr from public.v8_product_catalog where catalog_key=sc limit 1;end if;
 st:=case when sc is not null then 'resolved' when sg is not null then 'scope_only' when public.v8_resolve_group_context(p_message_text)->>'status'='ambiguous' then 'ambiguous' else 'unknown' end;
 clarify:=st in ('unknown','ambiguous') or (st='scope_only' and src not in ('customer_group','recent_group'));
 if cfg.use_slide_mapping and coalesce(array_length(folders,1),0)=0 and coalesce(sc,sr) is not null then
  select * into sm from public.v8_slide_mapping where is_active and (page_id is null or page_id=p_page_id) and product_key in (sc,sr) order by case when page_id=p_page_id then 0 else 1 end,priority limit 1;
  if sm.id is not null then folders:=public.v8_mapping_folder_ids(coalesce(sm.drive_folder_ids,'[]'::jsonb));if coalesce(array_length(folders,1),0)=0 and sm.drive_folder_id is not null then folders:=array[sm.drive_folder_id];end if;end if;
 end if;
 select count(*) into assets from public.v8_drive_assets x where x.is_active and x.is_image and coalesce(x.delivery_status,'verified')<>'error' and ((sc is not null and x.catalog_key=sc) or (coalesce(array_length(folders,1),0)>0 and x.parent_folder_id=any(folders)));
 applyit:=cfg.mode='ACTIVE' and st in ('resolved','scope_only') and conf>=coalesce(cfg.minimum_apply_confidence,.78);
 return jsonb_build_object('version','unified_mapping_v1','mode',cfg.mode,'status',st,'apply_to_runtime',applyit,'source',src,'confidence',round(conf,3),'conflict',conflict,'conflict_resolution',case when conflict then 'customer_message_wins' end,'needs_clarification',clarify,'group_key',sg,'catalog_key',sc,'root_product_key',sr,'ad_id',adid,'ad_title',adtitle,'ad_mapping_found',a.ad_id is not null,'slide_folder_ids',to_jsonb(folders),'slide_asset_count',assets,'resolved_at',now());
end;$f$;
comment on function public.v8_resolve_unified_mapping(text,text,text,jsonb,timestamptz) is 'Unified mapping decision. Customer wording overrides ad mapping; generic ads never force a product.';
