create or replace function public.v8_normalize_drive_folder_token(p_token text)
returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v text:=btrim(coalesce(p_token,''));
begin
  v:=regexp_replace(v,'[?#].*$','','g');
  if lower(v)='bathroom' then v:='PHÒNG TẮM';
  elsif lower(v) like 'bathroom/%' then v:='PHÒNG TẮM/'||substr(v,10);
  elsif lower(v)='kitchen' then v:='PHÒNG BẾP';
  elsif lower(v) like 'kitchen/%' then v:='PHÒNG BẾP/'||substr(v,9);
  end if;
  if lower(v)='phòng tắm/sen vòi 01' then v:='PHÒNG TẮM/SEN CÂY/Sen vòi'; end if;
  if lower(v)='phòng tắm/tủ chậu gương' then v:='PHÒNG TẮM/GƯƠNG-TỦ'; end if;
  v:=regexp_replace(v,E'\\s*[-–—]\\s*','-','g');
  v:=regexp_replace(v,E'\\s*/\\s*','/','g');
  return lower(v);
end;
$function$;

create or replace function public.v8_mapping_folder_ids(p_value jsonb)
returns text[]
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v jsonb;
  token text;
  direct_id text;
  normalized text;
  leaf text;
  resolved_id text;
  result_ids text[]:=array[]::text[];
begin
  for v in
    select value from jsonb_array_elements(
      case when jsonb_typeof(coalesce(p_value,'[]'::jsonb))='array' then coalesce(p_value,'[]'::jsonb) else '[]'::jsonb end
    )
  loop
    token:=case
      when jsonb_typeof(v)='string' then trim(both '"' from v::text)
      when jsonb_typeof(v)='object' then coalesce(v->>'id',v->>'folder_id',v->>'drive_folder_id',v->>'path',v->>'name')
      else null
    end;
    token:=nullif(btrim(coalesce(token,'')),'');
    if token is null then continue; end if;

    direct_id:=coalesce(
      substring(token from '/folders/([A-Za-z0-9_-]+)'),
      substring(token from '[?&]id=([A-Za-z0-9_-]+)'),
      token
    );
    resolved_id:=null;
    if exists(select 1 from public.v8_drive_assets where parent_folder_id=direct_id)
       or exists(select 1 from public.v8_product_catalog where drive_folder_id=direct_id and is_active) then
      resolved_id:=direct_id;
    end if;

    if resolved_id is null then
      normalized:=public.v8_normalize_drive_folder_token(token);
      select case when count(distinct c.drive_folder_id)=1 then min(c.drive_folder_id) end
      into resolved_id
      from public.v8_product_catalog c
      where c.is_active and c.drive_folder_id is not null
        and public.v8_normalize_drive_folder_token(coalesce(c.folder_path,c.catalog_name))=normalized;
    end if;

    if resolved_id is null then
      leaf:=regexp_replace(public.v8_normalize_drive_folder_token(token),'^.*/','','g');
      select case when count(distinct c.drive_folder_id)=1 then min(c.drive_folder_id) end
      into resolved_id
      from public.v8_product_catalog c
      where c.is_active and c.drive_folder_id is not null
        and regexp_replace(public.v8_normalize_drive_folder_token(coalesce(c.folder_path,c.catalog_name)),'^.*/','','g')=leaf;
    end if;

    result_ids:=array_append(result_ids,coalesce(resolved_id,token));
  end loop;

  select coalesce(array_agg(distinct id order by id) filter(where id is not null and id<>''),array[]::text[])
  into result_ids from unnest(result_ids) id;
  return result_ids;
end;
$function$;

comment on function public.v8_mapping_folder_ids(jsonb) is
'Converts legacy Drive paths, folder objects, URLs and folder IDs into canonical Drive folder IDs while preserving any unmatched token.';

with normalized as (
  select id,public.v8_mapping_folder_ids(
    coalesce(nullif(selected_folders,'[]'::jsonb),nullif(drive_folders,'[]'::jsonb),'[]'::jsonb)
  ) folder_ids
  from public.ad_mappings
)
update public.ad_mappings a
set selected_folders=to_jsonb(n.folder_ids),
    drive_folders=to_jsonb(n.folder_ids),
    mapping_target_type=case
      when nullif(a.product_item_key,'') is not null then 'product'
      when nullif(a.product_group,'') is not null and a.product_group<>'general' then 'group'
      when coalesce(array_length(n.folder_ids,1),0)>0 then 'scope'
      else coalesce(nullif(a.mapping_target_type,''),'scope')
    end,
    updated_at=now()
from normalized n
where n.id=a.id and coalesce(array_length(n.folder_ids,1),0)>0;

create or replace function public.v8_resolve_unified_mapping(
  p_page_id text,p_sender_id text,p_message_text text,p_referral jsonb default '{}'::jsonb,p_before timestamptz default now()
) returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
 cfg public.v8_mapping_runtime%rowtype; d record; g jsonb; a public.ad_mappings%rowtype;
 eg text; ec text; er text; ef numeric:=0;
 rg text; rc text; rr text; rad text; rf numeric:=0;
 ag text; ac text; ar text; af numeric:=0; asrc text;
 sg text; sc text; sr text; src text:='none'; conf numeric:=0;
 adid text:=nullif(btrim(coalesce(p_referral->>'ad_id','')),'');
 adtitle text:=nullif(btrim(coalesce(p_referral#>>'{ads_context_data,ad_title}',p_referral->>'ad_title','')),'');
 nk jsonb; folders text[]:=array[]::text[]; sm record; st text; conflict boolean:=false; clarify boolean:=false; applyit boolean:=false; newad boolean:=false; assets integer:=0;
begin
 select * into cfg from public.v8_mapping_runtime where page_id=p_page_id;
 if cfg.page_id is null then cfg.mode:='OBSERVE';cfg.use_ad_mapping:=true;cfg.use_recent_context:=true;cfg.use_slide_mapping:=true;cfg.minimum_apply_confidence:=0.78;cfg.recent_context_minutes:=60;end if;
 select * into d from public.v8_detect_catalog_smart(p_message_text) limit 1;
 g:=public.v8_resolve_group_context(p_message_text);
 if d.catalog_key is not null then ec:=d.catalog_key;er:=d.root_product_key;ef:=coalesce(d.confidence,0);select group_key into eg from public.v8_resolve_business_group(ec) limit 1;
 elsif g->>'status'='resolved' then eg:=g#>>'{group,group_key}';ef:=0.90;end if;
 if cfg.use_recent_context then
  select q.payload->'mapping_resolution'->>'group_key',q.payload->'mapping_resolution'->>'catalog_key',q.payload->'mapping_resolution'->>'root_product_key',q.payload->'mapping_resolution'->>'ad_id',coalesce((q.payload->'mapping_resolution'->>'confidence')::numeric,0.84)
  into rg,rc,rr,rad,rf from public.v8_processing_queue q join public.v8_messages_raw m on m.page_id=q.page_id and m.message_id=q.message_id
  where q.page_id=p_page_id and q.sender_id=p_sender_id and q.status='done' and m.direction='inbound' and m.sent_at<coalesce(p_before,now()) and m.sent_at>=coalesce(p_before,now())-make_interval(mins=>coalesce(cfg.recent_context_minutes,60)) and q.payload?'mapping_resolution'
  order by m.sent_at desc limit 1;
 end if;
 newad:=adid is not null and adid is distinct from rad;
 if cfg.use_ad_mapping and adid is not null then
  select * into a from public.ad_mappings where ad_id=adid and coalesce(enabled,true) and coalesce(is_active,true) limit 1;
  if a.ad_id is not null then
   nk:=public.v8_mapping_normalize_key(coalesce(nullif(a.product_item_key,''),nullif(a.product_group,''),nullif(a.slide_key,''),nullif(a.product_type,'')));
   ag:=nk->>'group_key';ac:=nk->>'catalog_key';ar:=nk->>'root_product_key';asrc:='ad_mapping';
   folders:=public.v8_mapping_folder_ids(coalesce(nullif(a.selected_folders,'[]'::jsonb),nullif(a.drive_folders,'[]'::jsonb),'[]'::jsonb));
   af:=case when ac is not null then .88 when ag is not null then .78 when coalesce(array_length(folders,1),0)>0 then .82 else 0 end;
  end if;
 end if;
 if cfg.use_ad_mapping and asrc is null and adtitle is not null then
  select * into d from public.v8_detect_catalog_smart(adtitle) limit 1;g:=public.v8_resolve_group_context(adtitle);
  if d.catalog_key is not null and coalesce(d.confidence,0)>=.62 then ac:=d.catalog_key;ar:=d.root_product_key;select group_key into ag from public.v8_resolve_business_group(ac) limit 1;af:=least(.76,coalesce(d.confidence,0));asrc:='ad_title';
  elsif g->>'status'='resolved' then ag:=g#>>'{group,group_key}';af:=.68;asrc:='ad_title_group';end if;
 end if;
 if ec is not null and ef>=.62 then sg:=eg;sc:=ec;sr:=er;src:='customer_explicit';conf:=ef;conflict:=coalesce(ac,ag) is not null and coalesce(ac,ag)<>coalesce(ec,eg);
 elsif eg is not null and ef>=.80 then sg:=eg;src:='customer_group';conf:=ef;conflict:=ag is not null and ag<>eg;
 elsif newad and ac is not null then sg:=ag;sc:=ac;sr:=ar;src:=asrc;conf:=af;
 elsif newad and ag is not null then sg:=ag;src:=asrc;conf:=af;
 elsif newad and coalesce(array_length(folders,1),0)>0 and public.v8_resolve_group_context(p_message_text)->>'status'<>'ambiguous' then src:='ad_folder_scope';conf:=af;
 elsif newad then src:=coalesce(asrc,'new_ad_unresolved');conf:=0;
 elsif rc is not null then sg:=rg;sc:=rc;sr:=rr;src:='recent_context';conf:=greatest(.84,rf);
 elsif ac is not null then sg:=ag;sc:=ac;sr:=ar;src:=asrc;conf:=af;
 elsif rg is not null then sg:=rg;src:='recent_group';conf:=.80;
 elsif ag is not null then sg:=ag;src:=asrc;conf:=af;
 elsif coalesce(array_length(folders,1),0)>0 and public.v8_resolve_group_context(p_message_text)->>'status'<>'ambiguous' then src:='ad_folder_scope';conf:=greatest(.82,af);end if;
 if sc is not null and sg is null then select group_key into sg from public.v8_resolve_business_group(sc) limit 1;end if;
 if sr is null and sc is not null then select root_product_key into sr from public.v8_product_catalog where catalog_key=sc limit 1;end if;
 st:=case when sc is not null then 'resolved' when sg is not null then 'scope_only' when src='ad_folder_scope' then 'folder_scope' when public.v8_resolve_group_context(p_message_text)->>'status'='ambiguous' then 'ambiguous' else 'unknown' end;
 clarify:=st in ('unknown','ambiguous') or (st='scope_only' and src not in ('customer_group','recent_group'));
 if cfg.use_slide_mapping and coalesce(array_length(folders,1),0)=0 and coalesce(sc,sr) is not null then
  select * into sm from public.v8_slide_mapping where is_active and (page_id is null or page_id=p_page_id) and product_key in (sc,sr) order by case when page_id=p_page_id then 0 else 1 end,priority limit 1;
  if sm.id is not null then folders:=public.v8_mapping_folder_ids(coalesce(sm.drive_folder_ids,'[]'::jsonb));if coalesce(array_length(folders,1),0)=0 and sm.drive_folder_id is not null then folders:=array[sm.drive_folder_id];end if;end if;
 end if;
 select count(*) into assets from public.v8_drive_assets x where x.is_active and x.is_image and coalesce(x.delivery_status,'verified')<>'error' and ((sc is not null and x.catalog_key in (select catalog_key from public.v8_catalog_descendant_keys(sc))) or (coalesce(array_length(folders,1),0)>0 and x.parent_folder_id=any(folders)));
 applyit:=cfg.mode='ACTIVE' and st in ('resolved','scope_only','folder_scope') and conf>=coalesce(cfg.minimum_apply_confidence,.78);
 return jsonb_build_object('version','unified_mapping_v2','mode',cfg.mode,'status',st,'apply_to_runtime',applyit,'source',src,'confidence',round(conf,3),'conflict',conflict,'conflict_resolution',case when conflict then 'customer_message_wins' end,'needs_clarification',clarify,'group_key',sg,'catalog_key',sc,'root_product_key',sr,'ad_id',adid,'ad_title',adtitle,'ad_mapping_found',a.ad_id is not null,'slide_folder_ids',to_jsonb(folders),'slide_asset_count',assets,'resolved_at',now());
end;
$function$;

comment on function public.v8_resolve_unified_mapping(text,text,text,jsonb,timestamptz) is
'Unified mapping v2. Customer wording wins; a configured multi-folder aggregate ad resolves to folder_scope without forcing one product.';

create or replace function public.v8_apply_unified_mapping_to_queue()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r jsonb; v_apply boolean; v_group text; v_catalog text; v_root text; v_conf numeric; v_payload jsonb;
  v_folder_ids text[]:=array[]::text[];
  v_validation_status text:=new.validation_status; v_validation_code text:=new.validation_code;
begin
  if new.queue_type<>'core_message' or new.status<>'done' then return new; end if;
  r:=public.v8_resolve_unified_mapping(new.page_id,new.sender_id,coalesce(new.payload->>'message_text',''),coalesce(new.payload->'referral','{}'::jsonb),coalesce(nullif(new.payload->>'event_time','')::timestamptz,new.created_at,now()));
  v_apply:=coalesce((r->>'apply_to_runtime')::boolean,false);
  v_group:=nullif(r->>'group_key',''); v_catalog:=nullif(r->>'catalog_key',''); v_root:=nullif(r->>'root_product_key',''); v_conf:=coalesce((r->>'confidence')::numeric,0);
  v_folder_ids:=public.v8_mapping_folder_ids(coalesce(r->'slide_folder_ids','[]'::jsonb));
  v_payload:=jsonb_set(coalesce(new.payload,'{}'::jsonb),'{mapping_resolution}',r,true);
  if v_apply then
    if new.intent_type='ask_sample' and (v_catalog is not null or coalesce(array_length(v_folder_ids,1),0)>0) and new.validation_code in ('MISSING_PRODUCT_FOR_SAMPLE','NO_ACTION_INTENT') then
      v_validation_status:='passed'; v_validation_code:='VALID';
      v_payload:=jsonb_set(v_payload,'{validation}',jsonb_build_object('code','VALID','status','passed','severity','info','should_plan_reply',true,'should_plan_slide',true,'details',jsonb_build_object('resolved_by','unified_mapping','source',r->>'source','confidence',v_conf)),true);
    end if;
    update public.v8_processing_queue set
      product_key=coalesce(v_group,v_root,product_key), catalog_key=coalesce(v_catalog,catalog_key),
      product_confidence=greatest(coalesce(product_confidence,0),v_conf),
      group_status=case when r->>'status' in ('resolved','scope_only','folder_scope') then 'resolved' else group_status end,
      validation_status=v_validation_status, validation_code=v_validation_code, payload=v_payload, updated_at=now()
    where id=new.id;
  else
    update public.v8_processing_queue set payload=v_payload,updated_at=now() where id=new.id;
  end if;
  return new;
end;
$function$;

create or replace function public.v8_plan_slides_for_queue(p_queue_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  q public.v8_processing_queue%rowtype;
  v_message_row_id uuid;
  v_policy record;
  v_repeat_hours integer:=72;
  v_max_images integer:=8;
  v_count integer:=0;
  v_status text;
  v_safety text;
  v_result jsonb;
  v_map jsonb;
  v_catalog text;
  v_group text;
  v_scope_key text;
  v_folder_ids text[]:=array[]::text[];
begin
  select * into q from public.v8_processing_queue where id=p_queue_id;
  if q.id is null then return jsonb_build_object('status','queue_not_found'); end if;
  v_map:=coalesce(q.payload->'mapping_resolution','{}'::jsonb);
  v_catalog:=coalesce(nullif(v_map->>'catalog_key',''),q.catalog_key);
  v_group:=coalesce(nullif(v_map->>'group_key',''),q.product_key);
  v_folder_ids:=public.v8_mapping_folder_ids(coalesce(v_map->'slide_folder_ids','[]'::jsonb));
  v_scope_key:=coalesce(v_catalog,v_group,case when coalesce(array_length(v_folder_ids,1),0)>0 then 'folder_scope:'||md5(array_to_string(v_folder_ids,',')) end);
  select * into v_policy from public.v8_resolve_runtime_policy(q.page_id) limit 1;
  select coalesce((value->>'slide_repeat_hours')::integer,72) into v_repeat_hours from public.v8_config_hub where key='dedupe' and scope='global' and is_active order by updated_at desc limit 1;
  v_repeat_hours:=least(greatest(coalesce(v_repeat_hours,72),1),720);
  select coalesce((value->>'max_images_queued_per_message')::integer,8) into v_max_images from public.v8_config_hub where key='observe_dedupe' and scope='global' and is_active order by updated_at desc limit 1;
  v_max_images:=least(greatest(coalesce(v_max_images,8),1),20);
  select id into v_message_row_id from public.v8_messages_raw where page_id=q.page_id and message_id=q.message_id limit 1;
  delete from public.v8_slide_logs where message_id=v_message_row_id and sent_at is null and send_status in ('queued','planned');
  if q.intent_type<>'ask_sample' then
    v_result:=jsonb_build_object('status','not_sample_request','planned',0);
  elsif q.validation_status<>'passed' then
    v_result:=jsonb_build_object('status','blocked_by_validation','validation_status',q.validation_status,'validation_code',q.validation_code,'planned',0);
  elsif (v_catalog is null and coalesce(array_length(v_folder_ids,1),0)=0) or v_message_row_id is null then
    v_result:=jsonb_build_object('status',case when v_group is not null then 'mapping_scope_requires_clarification' else 'missing_catalog_or_message' end,'planned',0,'mapping_resolution',v_map);
  elsif exists(select 1 from public.v8_slide_logs sl where sl.page_id=q.page_id and sl.sender_id=q.sender_id and coalesce(sl.catalog_key,sl.product_key)=v_scope_key and sl.created_at>=now()-make_interval(hours=>v_repeat_hours) and sl.send_status in ('planned','queued','sent')) then
    v_result:=jsonb_build_object('status','deduped','repeat_hours',v_repeat_hours,'planned',0);
  else
    v_status:=case when coalesce(v_policy.can_send_image,false) then 'queued' else 'planned' end;
    v_safety:=case when coalesce(v_policy.can_send_image,false) then 'ready_to_send' else lower(coalesce(v_policy.runtime_mode,'OBSERVE'))||'_only' end;
    with candidates as (
      select a.*,
        case when a.catalog_key=v_catalog then 0 when a.catalog_key in (select catalog_key from public.v8_catalog_descendant_keys(v_catalog)) then 1 else 2 end selection_rank,
        row_number() over(partition by a.parent_folder_id order by a.sort_order,a.file_name) folder_rank
      from public.v8_drive_assets a
      where a.is_active and a.is_image and coalesce(a.delivery_status,'verified')<>'error'
        and (a.catalog_key in (select catalog_key from public.v8_catalog_descendant_keys(v_catalog)) or (coalesce(array_length(v_folder_ids,1),0)>0 and a.parent_folder_id=any(v_folder_ids)))
    )
    insert into public.v8_slide_logs(customer_id,message_id,page_id,sender_id,product_key,catalog_key,folder_path,slide_url,send_status,decision_status,safety_status,reason,asset_id)
    select q.customer_id,v_message_row_id,q.page_id,q.sender_id,coalesce(v_group,v_scope_key),v_catalog,a.parent_folder_name,
      coalesce(nullif(a.delivery_url,''),a.file_url),v_status,'ready',v_safety,
      jsonb_build_object('queue_id',q.id,'runtime_mode',v_policy.runtime_mode,'can_send_image',v_policy.can_send_image,'validation_status',q.validation_status,'validation_code',q.validation_code,'mapping_resolution',v_map,'selection',case when a.catalog_key=v_catalog then 'exact_catalog' else 'catalog_descendant_or_folder' end),a.id
    from candidates a
    order by a.folder_rank,a.selection_rank,a.parent_folder_name,a.sort_order,a.file_name
    limit v_max_images
    on conflict(message_id,slide_url) where message_id is not null and slide_url is not null do nothing;
    get diagnostics v_count=row_count;
    v_result:=jsonb_build_object('status',case when v_count>0 then 'planned' else 'missing_assets' end,'planned',v_count,'send_status',v_status,'safety_status',v_safety,'repeat_hours',v_repeat_hours,'max_images',v_max_images,'mapping_resolution',v_map);
  end if;
  update public.v8_processing_queue set payload=(coalesce(payload,'{}'::jsonb)-'slide_plan')||jsonb_build_object('slide_plan',v_result),updated_at=now() where id=q.id;
  return v_result;
end;
$function$;

grant execute on function public.v8_normalize_drive_folder_token(text) to anon,authenticated,service_role;
grant execute on function public.v8_mapping_folder_ids(jsonb) to anon,authenticated,service_role;

