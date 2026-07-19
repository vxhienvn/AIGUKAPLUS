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
  v_folder_ids text[]:=array[]::text[];
begin
  select * into q from public.v8_processing_queue where id=p_queue_id;
  if q.id is null then return jsonb_build_object('status','queue_not_found'); end if;
  v_map:=coalesce(q.payload->'mapping_resolution','{}'::jsonb);
  v_catalog:=coalesce(nullif(v_map->>'catalog_key',''),q.catalog_key);
  v_group:=coalesce(nullif(v_map->>'group_key',''),q.product_key);
  v_folder_ids:=public.v8_mapping_folder_ids(coalesce(v_map->'slide_folder_ids','[]'::jsonb));
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
  elsif v_catalog is null or v_message_row_id is null then
    v_result:=jsonb_build_object('status',case when v_group is not null then 'mapping_scope_requires_clarification' else 'missing_catalog_or_message' end,'planned',0,'mapping_resolution',v_map);
  elsif exists(select 1 from public.v8_slide_logs sl where sl.page_id=q.page_id and sl.sender_id=q.sender_id and coalesce(sl.catalog_key,sl.product_key)=coalesce(v_catalog,v_group) and sl.created_at>=now()-make_interval(hours=>v_repeat_hours) and sl.send_status in ('planned','queued','sent')) then
    v_result:=jsonb_build_object('status','deduped','repeat_hours',v_repeat_hours,'planned',0);
  else
    v_status:=case when coalesce(v_policy.can_send_image,false) then 'queued' else 'planned' end;
    v_safety:=case when coalesce(v_policy.can_send_image,false) then 'ready_to_send' else lower(coalesce(v_policy.runtime_mode,'OBSERVE'))||'_only' end;
    insert into public.v8_slide_logs(customer_id,message_id,page_id,sender_id,product_key,catalog_key,folder_path,slide_url,send_status,decision_status,safety_status,reason,asset_id)
    select q.customer_id,v_message_row_id,q.page_id,q.sender_id,v_group,v_catalog,a.parent_folder_name,
      coalesce(nullif(a.delivery_url,''),a.file_url),v_status,'ready',v_safety,
      jsonb_build_object('queue_id',q.id,'runtime_mode',v_policy.runtime_mode,'can_send_image',v_policy.can_send_image,'validation_status',q.validation_status,'validation_code',q.validation_code,'mapping_resolution',v_map,'selection',case when a.catalog_key=v_catalog then 'exact_catalog' else 'catalog_descendant_or_folder' end),a.id
    from public.v8_drive_assets a
    where a.is_active and a.is_image and coalesce(a.delivery_status,'verified')<>'error'
      and (a.catalog_key in (select catalog_key from public.v8_catalog_descendant_keys(v_catalog)) or (coalesce(array_length(v_folder_ids,1),0)>0 and a.parent_folder_id=any(v_folder_ids)))
    order by case when a.catalog_key=v_catalog then 0 when a.catalog_key in (select catalog_key from public.v8_catalog_descendant_keys(v_catalog)) then 1 else 2 end,a.sort_order,a.file_name
    limit v_max_images
    on conflict(message_id,slide_url) where message_id is not null and slide_url is not null do nothing;
    get diagnostics v_count=row_count;
    v_result:=jsonb_build_object('status',case when v_count>0 then 'planned' else 'missing_assets' end,'planned',v_count,'send_status',v_status,'safety_status',v_safety,'repeat_hours',v_repeat_hours,'max_images',v_max_images,'mapping_resolution',v_map);
  end if;
  update public.v8_processing_queue set payload=(coalesce(payload,'{}'::jsonb)-'slide_plan')||jsonb_build_object('slide_plan',v_result),updated_at=now() where id=q.id;
  return v_result;
end;
$function$;

create or replace function public.v8_admin_test_unified_mapping(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_result jsonb; v_ref jsonb; v_assets jsonb;
begin
  perform public.v8_assert_admin_request();
  v_ref:=jsonb_strip_nulls(jsonb_build_object('ad_id',nullif(p_payload->>'ad_id',''),'source','ADS','ads_context_data',jsonb_build_object('ad_title',nullif(p_payload->>'ad_title',''))));
  v_result:=public.v8_resolve_unified_mapping(nullif(p_payload->>'page_id',''),coalesce(nullif(p_payload->>'sender_id',''),'mapping_test'),coalesce(p_payload->>'message_text',''),v_ref,now());
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_assets from (
    select id,catalog_key,product_key,parent_folder_id,parent_folder_name,file_name,coalesce(nullif(delivery_url,''),file_url) url
    from public.v8_drive_assets a
    where a.is_active and a.is_image and (
      a.catalog_key in (select catalog_key from public.v8_catalog_descendant_keys(nullif(v_result->>'catalog_key','')))
      or a.parent_folder_id=any(public.v8_mapping_folder_ids(v_result->'slide_folder_ids'))
    ) order by case when a.catalog_key=nullif(v_result->>'catalog_key','') then 0 else 1 end,a.sort_order,a.file_name limit 10
  ) x;
  return jsonb_build_object('resolution',v_result,'asset_preview',v_assets,'would_send_slide',coalesce(jsonb_array_length(v_assets),0)>0 and coalesce(p_payload->>'intent_type','ask_sample')='ask_sample');
end;
$function$;
