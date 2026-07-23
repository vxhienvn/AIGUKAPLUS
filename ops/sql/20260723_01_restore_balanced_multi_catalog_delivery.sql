-- Restore AI-selected multi-catalog carousels inside the canonical unified pipeline.
-- This migration keeps exact single-catalog delivery as a private path and adds
-- a verified balanced multi-product path. Text delivery waits for Meta to
-- confirm the required image/carousel delivery.

begin;

do $$
begin
  if to_regprocedure('public.v8_ai_stage_decision_single_catalog(uuid)') is null then
    alter function public.v8_ai_stage_decision(uuid) rename to v8_ai_stage_decision_single_catalog;
  end if;
  if to_regprocedure('public.v8_stage_slide_log_single_catalog(uuid)') is null then
    alter function public.v8_stage_slide_log(uuid) rename to v8_stage_slide_log_single_catalog;
  end if;
end
$$;

create or replace function public.v8_guard_single_catalog_carousel()
returns trigger
language plpgsql
security definer
set search_path='public'
as $$
declare
  v_catalog_count integer:=0;
  v_mode text;
begin
  if new.message_type<>'carousel' or new.status not in ('planned','ready','sending') then
    return new;
  end if;

  v_catalog_count:=public.v8_carousel_catalog_count(new.payload);
  v_mode:=coalesce(new.payload->>'slide_batch_mode','');

  if v_mode='multi_catalog_balanced'
     and coalesce(new.payload->>'catalog_key','')='multi_product'
     and coalesce(new.payload->>'product_key','')='multi_product'
     and v_catalog_count between 2 and 10
     and jsonb_array_length(coalesce(new.payload->'elements','[]'::jsonb)) between 2 and 10 then
    return new;
  end if;

  if coalesce(new.payload->>'catalog_key','')='multi_product'
     or coalesce(new.payload->>'product_key','')='multi_product'
     or v_catalog_count>1 then
    new.status:='cancelled';
    new.cancelled_at:=coalesce(new.cancelled_at,now());
    new.cancel_reason:='mixed_catalog_carousel_forbidden';
    new.last_error:=null;
    new.locked_at:=null;
    new.locked_by:=null;
    new.authorized_at:=null;
    new.authorized_by:=null;
    new.authorization_version:=null;
    new.authorization_details:=coalesce(new.authorization_details,'{}'::jsonb)||jsonb_build_object(
      'blocked_by','v8_guard_single_catalog_carousel',
      'catalog_count',v_catalog_count,
      'blocked_at',now(),
      'allowed_multi_mode','multi_catalog_balanced'
    );
    new.updated_at:=now();
  end if;
  return new;
end;
$$;

create or replace function public.v8_stage_slide_log(p_slide_log_id uuid)
returns jsonb
language plpgsql
security definer
set search_path='public'
as $$
declare
  s public.v8_slide_logs%rowtype;
  v_mode text;
  v_batch_key text;
  v_elements jsonb:='[]'::jsonb;
  v_slide_log_ids jsonb:='[]'::jsonb;
  v_asset_ids jsonb:='[]'::jsonb;
  v_source_catalogs jsonb:='[]'::jsonb;
  v_count integer:=0;
  v_catalog_count integer:=0;
  v_anchor uuid;
  v_outbound_id uuid;
  v_existing public.v8_outbound_queue%rowtype;
  v_due_at timestamptz:=now()+interval '1 second';
  v_source_system text;
begin
  select * into s from public.v8_slide_logs where id=p_slide_log_id for update;
  if s.id is null then return jsonb_build_object('ok',false,'error','slide_log_not_found'); end if;

  v_mode:=coalesce(s.reason->>'slide_batch_mode','');
  if v_mode<>'multi_catalog_balanced' then
    return public.v8_stage_slide_log_single_catalog(p_slide_log_id);
  end if;

  if s.message_id is null or s.ai_decision_id is null then
    return jsonb_build_object('ok',false,'error','multi_catalog_source_missing');
  end if;

  select m.source_system into v_source_system from public.v8_messages_raw m where m.id=s.message_id limit 1;
  if coalesce(v_source_system,'')='regression_test' or coalesce(s.page_id,'') like 'regression-%' then
    v_due_at:=now()+interval '1 hour';
  end if;

  v_batch_key:=coalesce(nullif(s.reason->>'slide_batch_key',''),'decision:'||s.ai_decision_id::text||':multi_product');

  with eligible as (
    select sl.id,sl.asset_id,sl.slide_url,sl.catalog_key,sl.product_key,
           coalesce(pc.catalog_name,sl.product_key,sl.catalog_key,'Mẫu sản phẩm') catalog_name,
           coalesce(nullif(sl.reason->>'requested_order','')::integer,2147483647) requested_order,
           sl.created_at
    from public.v8_slide_logs sl
    left join public.v8_product_catalog pc on pc.catalog_key=sl.catalog_key
    where sl.ai_decision_id=s.ai_decision_id
      and sl.send_status='queued'
      and sl.safety_status='ready_to_send'
      and coalesce(sl.reason->>'slide_batch_mode','')='multi_catalog_balanced'
      and nullif(btrim(coalesce(sl.slide_url,'')),'') is not null
    order by requested_order,sl.created_at,sl.id
    limit 10
  ), numbered as (
    select e.*,row_number() over(order by requested_order,created_at,id) rn from eligible e
  )
  select count(*)::integer,count(distinct catalog_key)::integer,
         (array_agg(id order by rn))[1],
         coalesce(jsonb_agg(jsonb_build_object(
           'title','Mẫu '||rn::text,
           'subtitle',left(coalesce(catalog_name,'Mẫu sản phẩm'),80),
           'image_url',slide_url
         ) order by rn),'[]'::jsonb),
         coalesce(jsonb_agg(id order by rn),'[]'::jsonb),
         coalesce(jsonb_agg(asset_id order by rn) filter(where asset_id is not null),'[]'::jsonb),
         coalesce(jsonb_agg(distinct catalog_key) filter(where catalog_key is not null),'[]'::jsonb)
  into v_count,v_catalog_count,v_anchor,v_elements,v_slide_log_ids,v_asset_ids,v_source_catalogs
  from numbered;

  if v_count<2 or v_catalog_count<2 then
    return jsonb_build_object('ok',false,'error','multi_catalog_batch_incomplete','elements',v_count,'catalog_count',v_catalog_count);
  end if;

  select * into v_existing
  from public.v8_outbound_queue q
  where q.ai_decision_id=s.ai_decision_id
    and q.message_type in ('carousel','generic_template','template')
  order by q.created_at limit 1 for update;

  if v_existing.id is null then
    insert into public.v8_outbound_queue(
      customer_id,page_id,sender_id,slide_log_id,ai_decision_id,pipeline_version,
      message_type,payload,status,due_at
    ) values(
      s.customer_id,s.page_id,s.sender_id,v_anchor,s.ai_decision_id,'unified_v1',
      'carousel',jsonb_build_object(
        'slide_batch_key',v_batch_key,
        'slide_batch_mode','multi_catalog_balanced',
        'catalog_key','multi_product','product_key','multi_product',
        'source_catalog_keys',v_source_catalogs,
        'elements',v_elements,'slide_log_ids',v_slide_log_ids,'asset_ids',v_asset_ids,
        'element_count',v_count,'delivery_mode','meta_generic_template_carousel',
        'ai_decision_id',s.ai_decision_id,'pipeline_version','unified_v1'
      ),'ready',v_due_at
    ) returning id into v_outbound_id;
  else
    update public.v8_outbound_queue
    set slide_log_id=coalesce(v_existing.slide_log_id,v_anchor),
        pipeline_version='unified_v1',message_type='carousel',
        payload=jsonb_build_object(
          'slide_batch_key',v_batch_key,
          'slide_batch_mode','multi_catalog_balanced',
          'catalog_key','multi_product','product_key','multi_product',
          'source_catalog_keys',v_source_catalogs,
          'elements',v_elements,'slide_log_ids',v_slide_log_ids,'asset_ids',v_asset_ids,
          'element_count',v_count,'delivery_mode','meta_generic_template_carousel',
          'ai_decision_id',s.ai_decision_id,'pipeline_version','unified_v1'
        ),
        due_at=case when status='sent' then due_at else v_due_at end,
        status=case when status='sent' then 'sent' when status='sending' then 'sending' else 'ready' end,
        attempts=case when status in ('cancelled','failed') then 0 else attempts end,
        cancelled_at=case when status='sent' then cancelled_at else null end,
        cancel_reason=case when status='sent' then cancel_reason else null end,
        last_error=case when status='sent' then last_error else null end,
        locked_at=case when status='sending' then locked_at else null end,
        locked_by=case when status='sending' then locked_by else null end,
        authorized_at=case when status='sending' then authorized_at else null end,
        authorized_by=case when status='sending' then authorized_by else null end,
        authorization_version=case when status='sending' then authorization_version else null end,
        authorization_details=case when status='sending' then authorization_details else '{}'::jsonb end,
        transport_confirmed_at=case when status='sending' then transport_confirmed_at else null end,
        transport_confirmed_by=case when status='sending' then transport_confirmed_by else null end,
        updated_at=now()
    where id=v_existing.id returning id into v_outbound_id;
  end if;

  update public.v8_slide_logs set pipeline_version='unified_v1'
  where id in (select value::uuid from jsonb_array_elements_text(v_slide_log_ids));

  return jsonb_build_object(
    'ok',true,'outbound_id',v_outbound_id,'status',coalesce(v_existing.status,'ready'),
    'message_type','carousel','batch_key',v_batch_key,
    'batch_mode','multi_catalog_balanced','element_count',v_count,
    'catalog_key','multi_product','source_catalog_keys',v_source_catalogs,'pipeline_version','unified_v1'
  );
end;
$$;

create or replace function public.v8_ai_stage_multi_catalog_decision(p_decision_id uuid)
returns jsonb
language plpgsql
security definer
set search_path='public','extensions'
as $$
declare
  d public.v8_ai_decisions%rowtype;
  r public.v8_ai_brain_runtime%rowtype;
  m public.v8_messages_raw%rowtype;
  s public.v8_conversation_states%rowtype;
  v_policy record;
  v_reply_plan_id uuid;
  v_existing_dispatch text;
  v_first_slide_id uuid;
  v_slide_stage jsonb:='{}'::jsonb;
  v_text_stage jsonb:='{}'::jsonb;
  v_selected_count integer:=0;
  v_catalog_count integer:=0;
  v_catalogs jsonb:='[]'::jsonb;
  v_available_after timestamptz:=now();
begin
  select * into d from public.v8_ai_decisions where id=p_decision_id for update;
  if d.id is null then return jsonb_build_object('ok',false,'reason','decision_not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended('v8_ai_stage_decision:'||d.id::text,0));

  select * into r from public.v8_ai_brain_runtime where page_id=d.page_id;
  if coalesce(r.mode,'OFF')<>'ACTIVE' then return jsonb_build_object('ok',true,'staged',false,'reason','brain_not_active'); end if;
  if d.status<>'completed' then return jsonb_build_object('ok',true,'staged',false,'reason','decision_not_completed','status',d.status); end if;
  if not d.should_reply or nullif(btrim(coalesce(d.final_reply,'')),'') is null then return jsonb_build_object('ok',true,'staged',false,'reason','no_reply_requested'); end if;
  if not d.should_send_slide or not coalesce(r.allow_images,false) then return public.v8_ai_stage_decision_single_catalog(p_decision_id); end if;

  if d.source_message_row_id is not null then select * into m from public.v8_messages_raw where id=d.source_message_row_id; end if;
  if m.id is null then select * into m from public.v8_messages_raw where page_id=d.page_id and message_id=d.message_id limit 1; end if;
  if m.id is null or m.direction<>'inbound' then return jsonb_build_object('ok',true,'staged',false,'reason','source_message_missing'); end if;

  select * into s from public.v8_conversation_states where customer_id=d.customer_id;
  if s.manual_pause_until>now() then return jsonb_build_object('ok',true,'staged',false,'reason','human_pause_active','until',s.manual_pause_until); end if;
  if exists(select 1 from public.v8_messages_raw x where x.customer_id=d.customer_id and x.direction='inbound' and x.sent_at>m.sent_at) then
    return jsonb_build_object('ok',true,'staged',false,'reason','newer_customer_message');
  end if;
  if exists(select 1 from public.v8_messages_raw x where x.customer_id=d.customer_id and x.direction='outbound' and x.sent_at>=m.sent_at
            and public.v8_is_actionable_external_outbound(x.source_system,x.message_text,x.attachments,x.is_automatic,x.actor_type,x.source_detail)) then
    return jsonb_build_object('ok',true,'staged',false,'reason','external_responder_replied');
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
  select count(*)::integer,count(distinct catalog_key)::integer,
         coalesce(jsonb_agg(distinct catalog_key) filter(where catalog_key is not null),'[]'::jsonb)
  into v_selected_count,v_catalog_count,v_catalogs from selected;

  if v_selected_count<2 or v_catalog_count<2 then
    return public.v8_ai_stage_decision_single_catalog(p_decision_id);
  end if;

  select * into v_policy from public.v8_resolve_runtime_policy(d.page_id) limit 1;
  if not coalesce(v_policy.can_send_text,false) or not coalesce(v_policy.can_send_image,false) then
    return jsonb_build_object('ok',true,'staged',false,'reason','runtime_delivery_blocked','runtime_mode',v_policy.runtime_mode);
  end if;

  select id,dispatch_status into v_reply_plan_id,v_existing_dispatch
  from public.v8_reply_plans where ai_decision_id=d.id for update;

  if v_reply_plan_id is null then
    insert into public.v8_reply_plans(
      customer_id,queue_id,page_id,sender_id,message_id,ai_decision_id,pipeline_version,
      business_group_key,intent_type,conversation_stage,action_type,suggested_reply,
      should_request_phone,should_ask_need,should_handoff_sale,safety_status,reason,
      send_eligible,blocked_reason,available_after,runtime_mode,is_latest_customer_turn,dispatch_status
    ) values(
      d.customer_id,null,d.page_id,d.sender_id,m.message_id,d.id,'unified_v1',
      'multi_product',d.intent_type,coalesce(nullif(d.decision->>'conversation_stage',''),'ai_decided'),
      coalesce(nullif(d.decision->>'action_type',''),'ai_response'),d.final_reply,
      d.should_request_contact,d.needs_clarification,d.should_handoff_sale,'ready_to_send',
      jsonb_build_object('ai_brain',true,'ai_decision_id',d.id,'provider_key',d.provider_key,'model_name',d.model_name,
        'confidence',d.confidence,'decision_authority',d.decision_authority,'pipeline_version','unified_v1',
        'slide_batch_mode','multi_catalog_balanced','source_catalog_keys',v_catalogs),
      true,null,v_available_after,coalesce(v_policy.runtime_mode,'OBSERVE'),true,'not_staged'
    ) returning id into v_reply_plan_id;
  elsif v_existing_dispatch<>'sent' then
    update public.v8_reply_plans
    set suggested_reply=d.final_reply,business_group_key='multi_product',intent_type=d.intent_type,
        action_type=coalesce(nullif(d.decision->>'action_type',''),'ai_response'),
        should_request_phone=d.should_request_contact,should_ask_need=d.needs_clarification,
        should_handoff_sale=d.should_handoff_sale,safety_status='ready_to_send',send_eligible=true,
        blocked_reason=null,available_after=v_available_after,runtime_mode=coalesce(v_policy.runtime_mode,'OBSERVE'),
        is_latest_customer_turn=true,dispatch_status='not_staged',dispatched_at=null,pipeline_version='unified_v1',
        reason=coalesce(reason,'{}'::jsonb)||jsonb_build_object('multi_catalog_restage',true,'slide_batch_mode','multi_catalog_balanced','source_catalog_keys',v_catalogs)
    where id=v_reply_plan_id;
  end if;

  with requested as (
    select value::uuid asset_id,ordinality::integer requested_order
    from jsonb_array_elements_text(coalesce(d.slide_asset_ids,'[]'::jsonb)) with ordinality
    where value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), candidates as (
    select a.*,rq.requested_order
    from requested rq join public.v8_drive_assets a on a.id=rq.asset_id
    where a.is_active and a.is_image and a.delivery_status='verified'
    order by rq.requested_order limit 10
  )
  insert into public.v8_slide_logs(
    customer_id,message_id,page_id,sender_id,ai_decision_id,pipeline_version,
    product_key,catalog_key,folder_path,slide_url,send_status,decision_status,safety_status,reason,asset_id
  )
  select d.customer_id,m.id,d.page_id,d.sender_id,d.id,'unified_v1',a.product_key,a.catalog_key,a.parent_folder_name,
         coalesce(nullif(a.delivery_url,''),a.file_url),'queued','ready','ready_to_send',
         jsonb_build_object('ai_brain',true,'ai_decision_id',d.id,'reply_plan_id',v_reply_plan_id,
           'slide_batch_key','decision:'||d.id::text||':multi_product','slide_batch_mode','multi_catalog_balanced',
           'requested_order',a.requested_order,'source_catalog_keys',v_catalogs,'target_images',v_selected_count,
           'available_after',v_available_after,'pipeline_version','unified_v1'),a.id
  from candidates a
  on conflict(ai_decision_id,asset_id) where ai_decision_id is not null and asset_id is not null do update set
    customer_id=excluded.customer_id,message_id=excluded.message_id,page_id=excluded.page_id,sender_id=excluded.sender_id,
    pipeline_version='unified_v1',product_key=excluded.product_key,catalog_key=excluded.catalog_key,
    folder_path=excluded.folder_path,slide_url=excluded.slide_url,
    send_status=case when public.v8_slide_logs.send_status='sent' then 'sent' else 'queued' end,
    decision_status=case when public.v8_slide_logs.send_status='sent' then public.v8_slide_logs.decision_status else 'ready' end,
    safety_status=case when public.v8_slide_logs.send_status='sent' then public.v8_slide_logs.safety_status else 'ready_to_send' end,
    reason=excluded.reason,send_error=null;

  select id into v_first_slide_id from public.v8_slide_logs
  where ai_decision_id=d.id and send_status='queued' and safety_status='ready_to_send'
  order by coalesce(nullif(reason->>'requested_order','')::integer,2147483647),created_at,id limit 1;

  if v_first_slide_id is null then
    return jsonb_build_object('ok',true,'staged',false,'reason','no_multi_catalog_slide_rows','reply_plan_id',v_reply_plan_id);
  end if;

  v_slide_stage:=public.v8_stage_slide_log(v_first_slide_id);
  if not coalesce((v_slide_stage->>'ok')::boolean,false) then
    return jsonb_build_object('ok',true,'staged',false,'reason','slide_stage_failed','slide_stage',v_slide_stage,'reply_plan_id',v_reply_plan_id);
  end if;

  if coalesce(v_existing_dispatch,'')<>'sent' then
    v_text_stage:=public.v8_stage_reply_plan(v_reply_plan_id);
  else
    v_text_stage:=jsonb_build_object('ok',true,'status','already_sent');
  end if;

  return jsonb_build_object('ok',true,'staged',true,'reply_plan_id',v_reply_plan_id,
    'text_stage',v_text_stage,'slide_stage',v_slide_stage,'slides_staged',v_selected_count,
    'slide_catalog','multi_product','multi_catalog',true,'source_catalog_keys',v_catalogs,
    'decision_authority','ai','pipeline_version','unified_v1');
end;
$$;

create or replace function public.v8_ai_stage_decision(p_decision_id uuid)
returns jsonb
language plpgsql
security definer
set search_path='public','extensions'
as $$
declare
  d public.v8_ai_decisions%rowtype;
  v_catalog_count integer:=0;
begin
  select * into d from public.v8_ai_decisions where id=p_decision_id;
  if d.id is null then return jsonb_build_object('ok',false,'reason','decision_not_found'); end if;

  if d.should_send_slide then
    with requested as (
      select value::uuid asset_id
      from jsonb_array_elements_text(coalesce(d.slide_asset_ids,'[]'::jsonb))
      where value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
    select count(distinct a.catalog_key)::integer into v_catalog_count
    from requested rq join public.v8_drive_assets a on a.id=rq.asset_id
    where a.is_active and a.is_image and a.delivery_status='verified';
  end if;

  if v_catalog_count>1 then
    return public.v8_ai_stage_multi_catalog_decision(p_decision_id);
  end if;
  return public.v8_ai_stage_decision_single_catalog(p_decision_id);
end;
$$;

create or replace function public.v8_gate_ai_text_until_slide_sent()
returns trigger
language plpgsql
security definer
set search_path='public'
as $$
declare
  v_requires_slide boolean:=false;
begin
  if new.message_type<>'text' or new.ai_decision_id is null or new.status in ('sent','cancelled','failed') then
    return new;
  end if;

  select coalesce(d.should_send_slide,false) into v_requires_slide
  from public.v8_ai_decisions d where d.id=new.ai_decision_id;

  if v_requires_slide and not exists(
    select 1 from public.v8_outbound_queue q
    where q.ai_decision_id=new.ai_decision_id
      and q.message_type in ('carousel','generic_template','template','image')
      and q.status='sent'
  ) then
    new.status:='planned';
    new.last_error:='awaiting_required_slide_delivery';
    new.locked_at:=null; new.locked_by:=null;
    new.authorized_at:=null; new.authorized_by:=null; new.authorization_version:=null;
    new.authorization_details:='{}'::jsonb;
    new.transport_confirmed_at:=null; new.transport_confirmed_by:=null;
    new.updated_at:=now();
  elsif v_requires_slide and new.last_error='awaiting_required_slide_delivery' then
    new.last_error:=null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_v8_00_gate_ai_text_until_slide_sent on public.v8_outbound_queue;
create trigger trg_v8_00_gate_ai_text_until_slide_sent
before insert or update of status,ai_decision_id,message_type on public.v8_outbound_queue
for each row execute function public.v8_gate_ai_text_until_slide_sent();

create or replace function public.v8_release_ai_text_after_slide_sent()
returns trigger
language plpgsql
security definer
set search_path='public'
as $$
begin
  if new.status='sent' and old.status is distinct from new.status
     and new.ai_decision_id is not null
     and new.message_type in ('carousel','generic_template','template','image') then
    update public.v8_outbound_queue q
    set status='ready',due_at=now(),last_error=null,updated_at=now()
    where q.ai_decision_id=new.ai_decision_id and q.message_type='text' and q.status='planned'
      and q.last_error='awaiting_required_slide_delivery';
  elsif new.status in ('cancelled','failed') and old.status is distinct from new.status
     and new.ai_decision_id is not null
     and new.message_type in ('carousel','generic_template','template','image') then
    update public.v8_outbound_queue q
    set status='cancelled',cancelled_at=now(),cancel_reason='required_slide_delivery_failed',
        last_error=null,updated_at=now()
    where q.ai_decision_id=new.ai_decision_id and q.message_type='text' and q.status='planned'
      and q.last_error='awaiting_required_slide_delivery';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_v8_release_ai_text_after_slide_sent on public.v8_outbound_queue;
create trigger trg_v8_release_ai_text_after_slide_sent
after update of status on public.v8_outbound_queue
for each row execute function public.v8_release_ai_text_after_slide_sent();

insert into public.v8_config_hub(scope,key,value,description,is_active,updated_at)
values('runtime','unified_ai_pipeline',jsonb_build_object(
  'version','unified_v2_balanced_carousel',
  'canonical_entrypoint','v8_ai_stage_decision',
  'single_catalog_path','v8_ai_stage_decision_single_catalog',
  'multi_catalog_path','v8_ai_stage_multi_catalog_decision',
  'multi_catalog_transport','one_balanced_carousel_max_10',
  'text_waits_for_slide_confirmation',true,
  'activated_at',now()
),'Unified AI pipeline with balanced multi-catalog carousel and delivery dependency.',true,now())
on conflict(scope,key) do update set value=excluded.value,description=excluded.description,is_active=true,updated_at=now();

commit;
