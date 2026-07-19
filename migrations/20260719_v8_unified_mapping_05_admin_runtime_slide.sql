create or replace function public.v8_admin_set_mapping_runtime(p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_page text:=nullif(btrim(p_payload->>'page_id'),''); v_row jsonb;
begin
  perform public.v8_assert_admin_request();
  if v_page is null then raise exception 'missing_page_id'; end if;
  insert into public.v8_mapping_runtime(page_id,mode,use_ad_mapping,use_recent_context,use_slide_mapping,minimum_apply_confidence,recent_context_minutes,updated_by,metadata)
  values(v_page,coalesce(nullif(p_payload->>'mode',''),'OBSERVE'),coalesce((p_payload->>'use_ad_mapping')::boolean,true),coalesce((p_payload->>'use_recent_context')::boolean,true),coalesce((p_payload->>'use_slide_mapping')::boolean,true),coalesce((p_payload->>'minimum_apply_confidence')::numeric,0.78),coalesce((p_payload->>'recent_context_minutes')::integer,60),coalesce(nullif(p_payload->>'actor',''),'admin_ui'),coalesce(p_payload->'metadata','{}'::jsonb))
  on conflict(page_id) do update set mode=excluded.mode,use_ad_mapping=excluded.use_ad_mapping,use_recent_context=excluded.use_recent_context,use_slide_mapping=excluded.use_slide_mapping,minimum_apply_confidence=excluded.minimum_apply_confidence,recent_context_minutes=excluded.recent_context_minutes,updated_by=excluded.updated_by,metadata=excluded.metadata,updated_at=now()
  returning to_jsonb(v8_mapping_runtime.*) into v_row;
  insert into public.v8_admin_change_log(actor,action,asset_type,asset_id,after_data) values(coalesce(nullif(p_payload->>'actor',''),'admin_ui'),'set_mapping_runtime','page',v_page,v_row);
  return v_row;
end;
$function$;

create or replace function public.v8_admin_disable_ad_mapping(p_ad_id text,p_actor text default 'admin_ui')
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_row jsonb;
begin
  perform public.v8_assert_admin_request();
  update public.ad_mappings set enabled=false,is_active=false,updated_at=now() where ad_id=p_ad_id returning to_jsonb(ad_mappings.*) into v_row;
  insert into public.v8_admin_change_log(actor,action,asset_type,asset_id,after_data) values(coalesce(nullif(p_actor,''),'admin_ui'),'disable_ad_mapping','ad',p_ad_id,coalesce(v_row,'{}'::jsonb));
  return coalesce(v_row,'{}'::jsonb);
end;
$function$;

create or replace function public.v8_admin_save_slide_mapping(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_key text:=nullif(btrim(p_payload->>'product_key'),''); v_page text:=nullif(btrim(p_payload->>'page_id'),''); v_row jsonb;
begin
  perform public.v8_assert_admin_request();
  if v_key is null then raise exception 'missing_product_key'; end if;
  update public.v8_slide_mapping
  set product_name=nullif(btrim(p_payload->>'product_name'),''),
      slide_url=nullif(btrim(p_payload->>'slide_url'),''),
      slide_title=nullif(btrim(p_payload->>'slide_title'),''),
      priority=coalesce((p_payload->>'priority')::integer,priority,100),
      is_active=coalesce((p_payload->>'is_active')::boolean,is_active,true),
      note=nullif(btrim(p_payload->>'note'),''),
      drive_folder_url=nullif(btrim(p_payload->>'drive_folder_url'),''),
      sync_mode=coalesce(nullif(p_payload->>'sync_mode',''),sync_mode,'manual_button'),
      drive_folder_id=nullif(btrim(p_payload->>'drive_folder_id'),''),
      drive_folder_ids=coalesce(p_payload->'drive_folder_ids',drive_folder_ids,'[]'::jsonb),
      sync_status=coalesce(nullif(p_payload->>'sync_status',''),sync_status,'idle'),
      updated_at=now()
  where coalesce(page_id,'')=coalesce(v_page,'') and product_key=v_key and coalesce(slide_title,'')=coalesce(nullif(btrim(p_payload->>'slide_title'),''),'');
  if found then
    select to_jsonb(sm) into v_row from public.v8_slide_mapping sm
    where coalesce(sm.page_id,'')=coalesce(v_page,'') and sm.product_key=v_key and coalesce(sm.slide_title,'')=coalesce(nullif(btrim(p_payload->>'slide_title'),''),'') limit 1;
  else
    insert into public.v8_slide_mapping(page_id,product_key,product_name,slide_url,slide_title,priority,is_active,note,drive_folder_url,sync_mode,drive_folder_id,drive_folder_ids,sync_status,updated_at)
    values(v_page,v_key,nullif(btrim(p_payload->>'product_name'),''),nullif(btrim(p_payload->>'slide_url'),''),nullif(btrim(p_payload->>'slide_title'),''),coalesce((p_payload->>'priority')::integer,100),coalesce((p_payload->>'is_active')::boolean,true),nullif(btrim(p_payload->>'note'),''),nullif(btrim(p_payload->>'drive_folder_url'),''),coalesce(nullif(p_payload->>'sync_mode',''),'manual_button'),nullif(btrim(p_payload->>'drive_folder_id'),''),coalesce(p_payload->'drive_folder_ids','[]'::jsonb),coalesce(nullif(p_payload->>'sync_status',''),'idle'),now())
    returning to_jsonb(v8_slide_mapping.*) into v_row;
  end if;
  insert into public.v8_admin_change_log(actor,action,asset_type,asset_id,after_data) values(coalesce(nullif(p_payload->>'actor',''),'admin_ui'),'save_slide_mapping','product',v_key,v_row);
  return v_row;
end;
$function$;
