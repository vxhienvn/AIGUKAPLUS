-- Safe recovery for a completed AI decision whose text was delivered but its
-- required carousel was not. Recovery is refused after a newer customer turn
-- or a confirmed external responder. Also re-anchor revived carousels away
-- from stale cancelled slide rows.

create or replace function public.v8_reanchor_carousel_to_sendable_slide()
returns trigger
language plpgsql
security definer
set search_path='public'
as $$
declare
  v_anchor uuid;
begin
  if new.message_type not in ('carousel','generic_template','template')
     or new.status not in ('ready','sending')
     or new.ai_decision_id is null then
    return new;
  end if;

  if new.slide_log_id is null or not exists(
    select 1 from public.v8_slide_logs sl
    where sl.id=new.slide_log_id and sl.send_status='queued' and sl.safety_status='ready_to_send'
  ) then
    select sl.id into v_anchor
    from public.v8_slide_logs sl
    where sl.ai_decision_id=new.ai_decision_id
      and sl.send_status='queued' and sl.safety_status='ready_to_send'
      and (jsonb_typeof(new.payload->'slide_log_ids')<>'array'
           or sl.id in (select value::uuid from jsonb_array_elements_text(new.payload->'slide_log_ids')))
    order by coalesce(nullif(sl.reason->>'requested_order','')::integer,2147483647),sl.created_at,sl.id
    limit 1;
    if v_anchor is not null then
      new.slide_log_id:=v_anchor;
      new.authorization_details:=coalesce(new.authorization_details,'{}'::jsonb)||jsonb_build_object(
        'carousel_reanchored',true,'carousel_reanchored_at',now(),'sendable_slide_log_id',v_anchor
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists a0_trg_v8_reanchor_carousel_to_sendable_slide on public.v8_outbound_queue;
create trigger a0_trg_v8_reanchor_carousel_to_sendable_slide
before insert or update of status,payload,slide_log_id,ai_decision_id on public.v8_outbound_queue
for each row execute function public.v8_reanchor_carousel_to_sendable_slide();

create or replace function public.v8_recover_missing_slides_for_decision(p_decision_id uuid)
returns jsonb
language plpgsql
security definer
set search_path='public','extensions'
as $$
declare
  d public.v8_ai_decisions%rowtype;
  m public.v8_messages_raw%rowtype;
  v_catalog_count integer:=0;
  v_catalog text;
  v_asset_count integer:=0;
  v_first_slide uuid;
  v_stage jsonb:='{}'::jsonb;
begin
  select * into d from public.v8_ai_decisions where id=p_decision_id for update;
  if d.id is null then return jsonb_build_object('ok',false,'reason','decision_not_found'); end if;
  if d.status<>'completed' or not d.should_send_slide then
    return jsonb_build_object('ok',true,'recovered',false,'reason','decision_not_eligible','status',d.status);
  end if;
  if d.source_message_row_id is not null then select * into m from public.v8_messages_raw where id=d.source_message_row_id; end if;
  if m.id is null then select * into m from public.v8_messages_raw where page_id=d.page_id and message_id=d.message_id limit 1; end if;
  if m.id is null then return jsonb_build_object('ok',true,'recovered',false,'reason','source_missing'); end if;

  if exists(select 1 from public.v8_outbound_queue q where q.ai_decision_id=d.id and q.message_type in ('carousel','image','generic_template','template') and q.status='sent') then
    return jsonb_build_object('ok',true,'recovered',false,'reason','slide_already_sent');
  end if;
  if exists(select 1 from public.v8_messages_raw x where x.customer_id=d.customer_id and x.direction='inbound' and x.sent_at>m.sent_at) then
    return jsonb_build_object('ok',true,'recovered',false,'reason','newer_customer_message');
  end if;
  if exists(select 1 from public.v8_messages_raw x where x.customer_id=d.customer_id and x.direction='outbound' and x.sent_at>=m.sent_at
      and public.v8_is_actionable_external_outbound(x.source_system,x.message_text,x.attachments,x.is_automatic,x.actor_type,x.source_detail)) then
    return jsonb_build_object('ok',true,'recovered',false,'reason','external_responder_replied');
  end if;

  with requested as (
    select value::uuid asset_id,ordinality::integer requested_order
    from jsonb_array_elements_text(coalesce(d.slide_asset_ids,'[]'::jsonb)) with ordinality
    where value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), selected as (
    select a.id,a.catalog_key,rq.requested_order
    from requested rq join public.v8_drive_assets a on a.id=rq.asset_id
    where a.is_active and a.is_image and a.delivery_status='verified'
    order by rq.requested_order limit 10
  )
  select count(*)::integer,count(distinct catalog_key)::integer,min(catalog_key)
  into v_asset_count,v_catalog_count,v_catalog from selected;

  if v_catalog_count>1 then
    v_stage:=public.v8_ai_stage_multi_catalog_decision(d.id);
    return jsonb_build_object('ok',true,'recovered',coalesce((v_stage->>'staged')::boolean,false),'mode','multi_catalog','stage',v_stage);
  end if;
  if v_catalog_count<>1 or v_asset_count=0 then
    return jsonb_build_object('ok',true,'recovered',false,'reason','verified_assets_unavailable','asset_count',v_asset_count,'catalog_count',v_catalog_count);
  end if;

  with requested as (
    select value::uuid asset_id,ordinality::integer requested_order
    from jsonb_array_elements_text(coalesce(d.slide_asset_ids,'[]'::jsonb)) with ordinality
    where value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), candidates as (
    select a.*,rq.requested_order
    from requested rq join public.v8_drive_assets a on a.id=rq.asset_id
    where a.is_active and a.is_image and a.delivery_status='verified' and a.catalog_key=v_catalog
    order by rq.requested_order limit 10
  )
  insert into public.v8_slide_logs(
    customer_id,message_id,page_id,sender_id,ai_decision_id,pipeline_version,
    product_key,catalog_key,folder_path,slide_url,send_status,decision_status,safety_status,reason,asset_id
  )
  select d.customer_id,m.id,d.page_id,d.sender_id,d.id,'unified_v1',a.product_key,a.catalog_key,a.parent_folder_name,
         coalesce(nullif(a.delivery_url,''),a.file_url),'queued','ready','ready_to_send',
         jsonb_build_object('ai_brain',true,'ai_decision_id',d.id,
           'slide_batch_key','decision:'||d.id::text,'slide_batch_mode','single_catalog',
           'requested_order',a.requested_order,'target_images',v_asset_count,
           'recovery_reason','text_sent_without_required_slide','pipeline_version','unified_v1'),a.id
  from candidates a
  on conflict(ai_decision_id,asset_id) where ai_decision_id is not null and asset_id is not null do update set
    customer_id=excluded.customer_id,message_id=excluded.message_id,page_id=excluded.page_id,sender_id=excluded.sender_id,
    product_key=excluded.product_key,catalog_key=excluded.catalog_key,folder_path=excluded.folder_path,
    slide_url=excluded.slide_url,pipeline_version='unified_v1',
    send_status=case when public.v8_slide_logs.send_status='sent' then 'sent' else 'queued' end,
    decision_status=case when public.v8_slide_logs.send_status='sent' then public.v8_slide_logs.decision_status else 'ready' end,
    safety_status=case when public.v8_slide_logs.send_status='sent' then public.v8_slide_logs.safety_status else 'ready_to_send' end,
    reason=excluded.reason,send_error=null;

  select id into v_first_slide from public.v8_slide_logs
  where ai_decision_id=d.id and send_status='queued' and safety_status='ready_to_send'
  order by coalesce(nullif(reason->>'requested_order','')::integer,2147483647),created_at,id limit 1;

  if v_first_slide is null then
    return jsonb_build_object('ok',true,'recovered',false,'reason','no_queued_slide_rows');
  end if;

  v_stage:=public.v8_stage_slide_log(v_first_slide);
  return jsonb_build_object('ok',true,'recovered',coalesce((v_stage->>'ok')::boolean,false),
    'mode','single_catalog','catalog_key',v_catalog,'asset_count',v_asset_count,'stage',v_stage);
end;
$$;

create or replace function public.v8_regression_test_multi_catalog_delivery_dependency()
returns jsonb
language plpgsql
security definer
set search_path='public','extensions'
as $$
declare
  v_customer uuid:=gen_random_uuid();
  v_sender text:='regression-multi-'||replace(gen_random_uuid()::text,'-','');
  v_message_id text:='regression-multi-msg-'||replace(gen_random_uuid()::text,'-','');
  v_message_row uuid;
  v_decision uuid;
  v_assets jsonb:='[]'::jsonb;
  v_stage jsonb;
  v_carousel_id uuid;
  v_carousel_status text;
  v_elements integer:=0;
  v_catalog_count integer:=0;
  v_text_before text;
  v_text_after text;
  v_schedule jsonb;
  v_ok boolean:=false;
begin
  with cats as (
    select catalog_key from public.v8_drive_assets
    where is_active and is_image and delivery_status='verified' and catalog_key is not null
    group by catalog_key having count(*)>=5 order by catalog_key limit 2
  ), ranked as (
    select a.id,a.catalog_key,row_number() over(partition by a.catalog_key order by a.sort_order,a.file_name,a.id) rn,
           dense_rank() over(order by a.catalog_key) cat_rank
    from public.v8_drive_assets a join cats c on c.catalog_key=a.catalog_key
    where a.is_active and a.is_image and a.delivery_status='verified'
  ), chosen as (
    select * from ranked where rn<=5 order by rn,cat_rank
  )
  select coalesce(jsonb_agg(id order by rn,cat_rank),'[]'::jsonb) into v_assets from chosen;

  if jsonb_array_length(v_assets)<>10 then
    return jsonb_build_object('ok',false,'error','not_enough_two_catalog_assets','asset_count',jsonb_array_length(v_assets));
  end if;

  insert into public.v8_customers(id,page_id,page_name,sender_id,display_name,first_seen_at,last_seen_at)
  values(v_customer,'104810069068200','Regression',v_sender,'Regression Multi',now(),now());

  insert into public.v8_messages_raw(customer_id,page_id,sender_id,message_id,direction,actor_type,actor_name,message_text,source_system,is_automatic,sent_at)
  values(v_customer,'104810069068200',v_sender,v_message_id,'inbound','customer','Regression Multi','Gửi mẫu hai nhóm sản phẩm','regression_test',false,now())
  returning id into v_message_row;

  insert into public.v8_ai_decisions(
    page_id,sender_id,customer_id,message_id,source_message_row_id,runtime_mode,provider_key,model_name,status,
    customer_goal,intent_type,product_scope,catalog_key,confidence,should_reply,final_reply,should_send_slide,
    slide_asset_ids,should_request_contact,should_handoff_sale,needs_clarification,decision,evidence_summary,risk_flags,completed_at
  ) values(
    '104810069068200',v_sender,v_customer,v_message_id,v_message_row,'PRODUCTION','openai','regression-test','completed',
    'Xem hai nhóm mẫu','ask_sample','multi_product','multi_product',0.99,true,
    'Dạ em gửi bạn vài mẫu của hai nhóm để tham khảo ạ.',true,v_assets,true,false,false,
    jsonb_build_object('conversation_stage','need_identified','action_type','reply_with_slide'),
    jsonb_build_array(jsonb_build_object('source_type','regression','claim','balanced multi catalog')),'[]'::jsonb,now()
  ) returning id into v_decision;

  v_stage:=public.v8_ai_stage_decision(v_decision);

  select q.id,q.status,jsonb_array_length(coalesce(q.payload->'elements','[]'::jsonb)),public.v8_carousel_catalog_count(q.payload)
  into v_carousel_id,v_carousel_status,v_elements,v_catalog_count
  from public.v8_outbound_queue q
  where q.ai_decision_id=v_decision and q.message_type='carousel' limit 1;

  select status into v_text_before from public.v8_outbound_queue
  where ai_decision_id=v_decision and message_type='text' limit 1;

  update public.v8_outbound_queue set status='sent',sent_at=now(),updated_at=now() where id=v_carousel_id;
  select status into v_text_after from public.v8_outbound_queue
  where ai_decision_id=v_decision and message_type='text' limit 1;

  v_schedule:=public.v8_follow_up_schedule(
    (date_trunc('day',now() at time zone 'Asia/Bangkok')+interval '23 hours') at time zone 'Asia/Bangkok',
    true,false,
    jsonb_build_object('timezone','Asia/Bangkok','quiet_hours_enabled',false,'evening_hot_hours',2,'evening_general_hours',3)
  );

  v_ok:=coalesce((v_stage->>'staged')::boolean,false)
    and v_elements=10 and v_catalog_count=2
    and v_text_before='planned' and v_text_after='ready'
    and coalesce((v_schedule->>'quiet_hours_deferred')::boolean,true)=false
    and v_schedule->>'daypart'='evening';

  delete from public.v8_outbound_queue where customer_id=v_customer;
  delete from public.v8_slide_logs where customer_id=v_customer;
  delete from public.v8_reply_plans where customer_id=v_customer;
  delete from public.v8_ai_decisions where customer_id=v_customer;
  delete from public.v8_ai_brain_requests where page_id='104810069068200' and sender_id=v_sender;
  delete from public.v8_processing_queue where page_id='104810069068200' and sender_id=v_sender;
  delete from public.v8_messages_raw where customer_id=v_customer;
  delete from public.v8_conversation_states where customer_id=v_customer;
  delete from public.v8_conversation_memory_ai where customer_id=v_customer;
  delete from public.v8_customers where id=v_customer;

  return jsonb_build_object('ok',v_ok,'stage',v_stage,'carousel_status',v_carousel_status,
    'carousel_elements',v_elements,'catalog_count',v_catalog_count,
    'text_status_before_slide',v_text_before,'text_status_after_slide',v_text_after,'overnight_schedule',v_schedule);
exception when others then
  delete from public.v8_outbound_queue where customer_id=v_customer;
  delete from public.v8_slide_logs where customer_id=v_customer;
  delete from public.v8_reply_plans where customer_id=v_customer;
  delete from public.v8_ai_decisions where customer_id=v_customer;
  delete from public.v8_ai_brain_requests where page_id='104810069068200' and sender_id=v_sender;
  delete from public.v8_processing_queue where page_id='104810069068200' and sender_id=v_sender;
  delete from public.v8_messages_raw where customer_id=v_customer;
  delete from public.v8_conversation_states where customer_id=v_customer;
  delete from public.v8_conversation_memory_ai where customer_id=v_customer;
  delete from public.v8_customers where id=v_customer;
  return jsonb_build_object('ok',false,'error',sqlerrm,'sqlstate',sqlstate);
end;
$$;
