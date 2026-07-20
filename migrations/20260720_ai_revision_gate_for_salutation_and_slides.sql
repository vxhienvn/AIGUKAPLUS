-- AIGUKA V8: rules detect violations; AI revises the decision before any send.

create table if not exists public.v8_ai_revision_requests(
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null unique references public.v8_ai_decisions(id) on delete cascade,
  page_id text not null,
  sender_id text not null,
  customer_id uuid,
  reasons jsonb not null default '[]'::jsonb,
  status text not null default 'pending' check(status in ('pending','processing','completed','error','failed')),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  last_error text,
  available_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_v8_ai_revision_requests_pending
on public.v8_ai_revision_requests(status,available_at,created_at);
alter table public.v8_ai_revision_requests enable row level security;
drop policy if exists v8_ai_revision_service_only on public.v8_ai_revision_requests;
create policy v8_ai_revision_service_only on public.v8_ai_revision_requests
for all using(auth.role()='service_role') with check(auth.role()='service_role');

create or replace function public.v8_capture_ai_authoritative_output()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  if new.status='completed' then
    if tg_op='INSERT' then
      if new.model_output is null then new.model_output:=public.v8_ai_authoritative_payload(new); end if;
      new.decision_authority:=coalesce(nullif(new.decision_authority,''),'ai_runtime');
    elsif old.status is distinct from 'completed' or new.model_output is null then
      new.model_output:=public.v8_ai_authoritative_payload(new);
      new.decision_authority:=coalesce(nullif(new.decision_authority,''),'ai_runtime');
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.v8_validate_ai_decision_before_stage()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_salutation text;
  v_norm text;
  v_available integer:=0;
  v_required integer:=0;
  v_selected integer:=0;
  v_selected_verified integer:=0;
  v_clean jsonb:='[]'::jsonb;
  v_has_block boolean:=false;
begin
  if new.status<>'completed' then return new; end if;

  select coalesce(jsonb_agg(e.value),'[]'::jsonb) into v_clean
  from jsonb_array_elements(coalesce(new.rule_advisories,'[]'::jsonb)) e(value)
  where coalesce(e.value->>'source','') not in ('salutation_policy','slide_count_policy');
  new.rule_advisories:=coalesce(v_clean,'[]'::jsonb);

  select r.salutation into v_salutation
  from public.v8_resolve_customer_salutation(new.customer_id) r limit 1;
  v_norm:=public.v8_normalize_detector_text(coalesce(new.final_reply,''));

  if v_salutation in ('anh','chị','cô','chú','em','bạn') and position('anh chi' in v_norm)>0 then
    new.rule_advisories:=new.rule_advisories||jsonb_build_array(jsonb_build_object(
      'source','salutation_policy','severity','block','recommended_action','ai_regenerate',
      'reason','KNOWN_SALUTATION_NOT_APPLIED','expected_salutation',v_salutation,'may_modify_ai_reply',false
    ));
  end if;

  if coalesce(new.should_send_slide,false) then
    select count(*) into v_available
    from public.v8_drive_assets a
    where a.is_active and a.is_image and a.delivery_status='verified'
      and ((nullif(new.catalog_key,'') is not null and a.catalog_key=new.catalog_key)
        or (nullif(new.catalog_key,'') is null and nullif(new.product_scope,'') is not null
          and (a.catalog_key=new.product_scope or a.product_key=new.product_scope)));

    v_selected:=jsonb_array_length(coalesce(new.slide_asset_ids,'[]'::jsonb));
    select count(*) into v_selected_verified
    from jsonb_array_elements_text(coalesce(new.slide_asset_ids,'[]'::jsonb)) s(value)
    join public.v8_drive_assets a on a.id::text=s.value
    where a.is_active and a.is_image and a.delivery_status='verified';

    v_required:=least(5,v_available);
    if v_available>0 and (v_selected<v_required or v_selected_verified<v_selected or v_selected>10) then
      new.rule_advisories:=new.rule_advisories||jsonb_build_array(jsonb_build_object(
        'source','slide_count_policy','severity','block','recommended_action','ai_regenerate',
        'reason','SLIDE_SELECTION_OUTSIDE_VERIFIED_5_TO_10_POLICY',
        'available_verified',v_available,'required_minimum',v_required,
        'selected_total',v_selected,'selected_verified',v_selected_verified,
        'may_modify_ai_reply',false
      ));
    end if;
  end if;

  select exists(
    select 1 from jsonb_array_elements(coalesce(new.rule_advisories,'[]'::jsonb)) e(value)
    where e.value->>'severity'='block'
  ) into v_has_block;

  if v_has_block then
    new.status:='revision_required';
    new.error:='AI_REVISION_REQUIRED';
    new.updated_at:=now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_v8_zz_validate_ai_decision_before_stage on public.v8_ai_decisions;
create trigger trg_v8_zz_validate_ai_decision_before_stage
before insert or update of status,final_reply,should_send_slide,slide_asset_ids,customer_id,catalog_key,product_scope,rule_advisories
on public.v8_ai_decisions
for each row execute function public.v8_validate_ai_decision_before_stage();

create or replace function public.v8_enqueue_ai_revision_after_validation()
returns trigger
language plpgsql
security definer
set search_path=public,net
as $$
declare v_id uuid; v_reasons jsonb;
begin
  if new.status='revision_required' and old.status is distinct from 'revision_required' then
    select coalesce(jsonb_agg(e.value),'[]'::jsonb) into v_reasons
    from jsonb_array_elements(coalesce(new.rule_advisories,'[]'::jsonb)) e(value)
    where e.value->>'severity'='block';

    insert into public.v8_ai_revision_requests(decision_id,page_id,sender_id,customer_id,reasons,status,available_at,updated_at)
    values(new.id,new.page_id,new.sender_id,new.customer_id,v_reasons,'pending',now(),now())
    on conflict(decision_id) do update set
      reasons=excluded.reasons,
      status=case when public.v8_ai_revision_requests.attempts<public.v8_ai_revision_requests.max_attempts then 'pending' else 'failed' end,
      available_at=now(),last_error=null,updated_at=now()
    returning id into v_id;

    if exists(select 1 from public.v8_ai_revision_requests where id=v_id and status='pending') then
      perform net.http_post(
        url:='https://ezygfpeeqbbirdeazene.supabase.co/functions/v1/aiguka-v8-ai-reviser',
        headers:='{"Content-Type":"application/json"}'::jsonb,
        body:=jsonb_build_object('request_id',v_id),timeout_milliseconds:=120000
      );
    end if;
  end if;
  return new;
exception when others then return new;
end;
$$;

drop trigger if exists trg_v8_ai_enqueue_revision on public.v8_ai_decisions;
create trigger trg_v8_ai_enqueue_revision
after update of status on public.v8_ai_decisions
for each row execute function public.v8_enqueue_ai_revision_after_validation();

create or replace function public.v8_enqueue_ai_revision_insert()
returns trigger
language plpgsql
security definer
set search_path=public,net
as $$
declare v_id uuid; v_reasons jsonb;
begin
  if new.status<>'revision_required' then return new; end if;
  select coalesce(jsonb_agg(e.value),'[]'::jsonb) into v_reasons
  from jsonb_array_elements(coalesce(new.rule_advisories,'[]'::jsonb)) e(value)
  where e.value->>'severity'='block';

  insert into public.v8_ai_revision_requests(decision_id,page_id,sender_id,customer_id,reasons,status,available_at,updated_at)
  values(new.id,new.page_id,new.sender_id,new.customer_id,v_reasons,'pending',now(),now())
  on conflict(decision_id) do update set reasons=excluded.reasons,status='pending',available_at=now(),last_error=null,updated_at=now()
  returning id into v_id;

  perform net.http_post(
    url:='https://ezygfpeeqbbirdeazene.supabase.co/functions/v1/aiguka-v8-ai-reviser',
    headers:='{"Content-Type":"application/json"}'::jsonb,
    body:=jsonb_build_object('request_id',v_id),timeout_milliseconds:=120000
  );
  return new;
exception when others then return new;
end;
$$;

drop trigger if exists trg_v8_ai_enqueue_revision_insert on public.v8_ai_decisions;
create trigger trg_v8_ai_enqueue_revision_insert
after insert on public.v8_ai_decisions
for each row execute function public.v8_enqueue_ai_revision_insert();

create or replace function public.v8_apply_ai_revision(
  p_request_id uuid,p_final_reply text,p_slide_asset_ids jsonb,p_should_send_slide boolean,
  p_revision_reason text,p_confidence numeric,p_model_name text
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  r public.v8_ai_revision_requests%rowtype;
  d public.v8_ai_decisions%rowtype;
  v_non_block jsonb:='[]'::jsonb;
  v_stage jsonb;
  v_status text;
begin
  select * into r from public.v8_ai_revision_requests where id=p_request_id for update;
  if r.id is null then raise exception 'revision_request_not_found'; end if;
  if r.status<>'processing' then raise exception 'revision_request_not_processing'; end if;
  select * into d from public.v8_ai_decisions where id=r.decision_id for update;
  if d.id is null then raise exception 'revision_decision_not_found'; end if;

  select coalesce(jsonb_agg(e.value),'[]'::jsonb) into v_non_block
  from jsonb_array_elements(coalesce(d.rule_advisories,'[]'::jsonb)) e(value)
  where coalesce(e.value->>'severity','')<>'block';

  update public.v8_ai_decisions
  set status='completed',final_reply=left(coalesce(p_final_reply,''),1800),
      slide_asset_ids=coalesce(p_slide_asset_ids,'[]'::jsonb),
      should_send_slide=coalesce(p_should_send_slide,false),
      confidence=least(1,greatest(0,coalesce(p_confidence,d.confidence,0.8))),
      decision=coalesce(d.decision,'{}'::jsonb)||jsonb_build_object(
        'final_reply',left(coalesce(p_final_reply,''),1800),
        'slide_asset_ids',coalesce(p_slide_asset_ids,'[]'::jsonb),
        'should_send_slide',coalesce(p_should_send_slide,false),
        'revision_reason',coalesce(p_revision_reason,'AI policy correction'),
        'revision_model',coalesce(p_model_name,d.model_name),'revision_at',now()),
      rule_advisories=v_non_block,model_output=null,decision_authority='ai_revision',
      model_name=coalesce(nullif(p_model_name,''),d.model_name),error=null,completed_at=now(),updated_at=now()
  where id=d.id returning status into v_status;

  if v_status<>'completed' then raise exception 'revised_decision_still_invalid'; end if;
  v_stage:=public.v8_ai_stage_decision(d.id);
  update public.v8_ai_revision_requests
  set status='completed',completed_at=now(),last_error=null,updated_at=now()
  where id=r.id;
  return jsonb_build_object('ok',true,'request_id',r.id,'decision_id',d.id,'decision_authority','ai_revision','staged',v_stage);
exception when others then
  update public.v8_ai_revision_requests
  set status=case when attempts>=max_attempts then 'failed' else 'error' end,
      last_error=left(sqlerrm,1000),available_at=now()+interval '5 seconds',updated_at=now()
  where id=p_request_id;
  raise;
end;
$$;
