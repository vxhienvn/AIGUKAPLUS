create or replace function public.v8_apply_unified_mapping_to_queue()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r jsonb;
  v_apply boolean;
  v_group text;
  v_catalog text;
  v_root text;
  v_conf numeric;
  v_payload jsonb;
  v_validation_status text:=new.validation_status;
  v_validation_code text:=new.validation_code;
begin
  if new.queue_type<>'core_message' or new.status<>'done' then return new; end if;
  r:=public.v8_resolve_unified_mapping(new.page_id,new.sender_id,coalesce(new.payload->>'message_text',''),coalesce(new.payload->'referral','{}'::jsonb),coalesce(nullif(new.payload->>'event_time','')::timestamptz,new.created_at,now()));
  v_apply:=coalesce((r->>'apply_to_runtime')::boolean,false);
  v_group:=nullif(r->>'group_key',''); v_catalog:=nullif(r->>'catalog_key',''); v_root:=nullif(r->>'root_product_key',''); v_conf:=coalesce((r->>'confidence')::numeric,0);
  v_payload:=jsonb_set(coalesce(new.payload,'{}'::jsonb),'{mapping_resolution}',r,true);

  if v_apply then
    if new.intent_type='ask_sample' and v_catalog is not null and new.validation_code in ('MISSING_PRODUCT_FOR_SAMPLE','NO_ACTION_INTENT') then
      v_validation_status:='passed'; v_validation_code:='VALID';
      v_payload:=jsonb_set(v_payload,'{validation}',jsonb_build_object(
        'code','VALID','status','passed','severity','info','should_plan_reply',true,'should_plan_slide',true,
        'details',jsonb_build_object('resolved_by','unified_mapping','source',r->>'source','confidence',v_conf)
      ),true);
    end if;
    update public.v8_processing_queue
    set product_key=coalesce(v_group,v_root,product_key),
        catalog_key=coalesce(v_catalog,catalog_key),
        product_confidence=greatest(coalesce(product_confidence,0),v_conf),
        group_status=case when r->>'status' in ('resolved','scope_only') then 'resolved' else group_status end,
        validation_status=v_validation_status,
        validation_code=v_validation_code,
        payload=v_payload,
        updated_at=now()
    where id=new.id;
  else
    update public.v8_processing_queue set payload=v_payload,updated_at=now() where id=new.id;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_v8_apply_unified_mapping_to_queue on public.v8_processing_queue;
create trigger trg_v8_apply_unified_mapping_to_queue
after update of status on public.v8_processing_queue
for each row when (new.status='done')
execute function public.v8_apply_unified_mapping_to_queue();

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
  elsif exists(
    select 1 from public.v8_slide_logs sl where sl.page_id=q.page_id and sl.sender_id=q.sender_id
      and coalesce(sl.catalog_key,sl.product_key)=coalesce(v_catalog,v_group)
      and sl.created_at>=now()-make_interval(hours=>v_repeat_hours) and sl.send_status in ('planned','queued','sent')
  ) then
    v_result:=jsonb_build_object('status','deduped','repeat_hours',v_repeat_hours,'planned',0);
  else
    v_status:=case when coalesce(v_policy.can_send_image,false) then 'queued' else 'planned' end;
    v_safety:=case when coalesce(v_policy.can_send_image,false) then 'ready_to_send' else lower(coalesce(v_policy.runtime_mode,'OBSERVE'))||'_only' end;
    insert into public.v8_slide_logs(customer_id,message_id,page_id,sender_id,product_key,catalog_key,folder_path,slide_url,send_status,decision_status,safety_status,reason,asset_id)
    select q.customer_id,v_message_row_id,q.page_id,q.sender_id,v_group,v_catalog,a.parent_folder_name,
      coalesce(nullif(a.delivery_url,''),a.file_url),v_status,'ready',v_safety,
      jsonb_build_object('queue_id',q.id,'runtime_mode',v_policy.runtime_mode,'can_send_image',v_policy.can_send_image,'validation_status',q.validation_status,'validation_code',q.validation_code,'mapping_resolution',v_map,'selection',case when a.catalog_key=v_catalog then 'exact_catalog' else 'configured_folder_mapping' end),a.id
    from public.v8_drive_assets a
    where a.is_active and a.is_image and coalesce(a.delivery_status,'verified')<>'error'
      and (a.catalog_key=v_catalog or (coalesce(array_length(v_folder_ids,1),0)>0 and a.parent_folder_id=any(v_folder_ids)))
    order by case when a.catalog_key=v_catalog then 0 else 1 end,a.sort_order,a.file_name
    limit v_max_images
    on conflict(message_id,slide_url) where message_id is not null and slide_url is not null do nothing;
    get diagnostics v_count=row_count;
    v_result:=jsonb_build_object('status',case when v_count>0 then 'planned' else 'missing_assets' end,'planned',v_count,'send_status',v_status,'safety_status',v_safety,'repeat_hours',v_repeat_hours,'max_images',v_max_images,'mapping_resolution',v_map);
  end if;
  update public.v8_processing_queue set payload=(coalesce(payload,'{}'::jsonb)-'slide_plan')||jsonb_build_object('slide_plan',v_result),updated_at=now() where id=q.id;
  return v_result;
end;
$function$;
