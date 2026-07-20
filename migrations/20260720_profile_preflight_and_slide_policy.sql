-- AIGUKA V8: sync Meta profile before AI and enforce 5-10 verified slide policy.

create or replace function public.v8_run_meta_sync_cycle()
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_reconcile jsonb;
  v_dispatch jsonb;
begin
  v_reconcile:=public.v8_reconcile_meta_sync_responses();
  v_dispatch:=public.v8_dispatch_meta_sync_batch(10);
  return jsonb_build_object('reconcile',v_reconcile,'dispatch',v_dispatch,'ran_at',now());
end;
$$;

do $$
declare v_job bigint;
begin
  for v_job in select jobid from cron.job where jobname='aiguka_v8_meta_profile_sync' loop
    perform cron.unschedule(v_job);
  end loop;
  perform cron.schedule('aiguka_v8_meta_profile_sync','* * * * *','select public.v8_run_meta_sync_cycle();');
end;
$$;

insert into public.v8_prompt_branches(
  branch_key,branch_name,trigger_description,conditions,instruction_text,
  example_customer_message,example_good_reply,priority,is_active,created_by,prompt_group_key,updated_at
) values (
  'ai_slide_count_and_salutation_policy_v2',
  'Số lượng slide và xưng hô bắt buộc',
  'Mọi lượt gửi slide hoặc có dữ liệu giới tính/xưng hô',
  jsonb_build_object('architecture','ai_first','scope','all_pages'),
  'QUY TẮC BẮT BUỘC: Trước khi trả lời phải dùng preferred_salutation hoặc gender đã xác minh trong hồ sơ khách. Nếu hồ sơ xác định nam thì dùng anh; nữ thì dùng chị; không được dùng anh/chị khi đã có xưng hô cụ thể. Khi khách xin mẫu/hình/catalogue và có từ 5 ảnh đã xác minh trở lên, phải gọi lookup_slides với limit từ 5 đến 10 và đưa 5-10 asset_id hợp lệ vào quyết định. Nếu nguồn chỉ có dưới 5 ảnh đã xác minh thì dùng toàn bộ số ảnh thực có. Không được chủ động chọn dưới 5 khi kho có ít nhất 5. Chỉ asset có delivery_status=verified mới được coi là ảnh gửi được.',
  'Xin ít ảnh mẫu lavabo',
  'Dạ em gửi anh 5-10 mẫu lavabo phù hợp để mình tham khảo trước ạ.',
  0,true,'system_fix','safety_control',now()
)
on conflict(branch_key) do update set
  branch_name=excluded.branch_name,
  trigger_description=excluded.trigger_description,
  conditions=excluded.conditions,
  instruction_text=excluded.instruction_text,
  example_customer_message=excluded.example_customer_message,
  example_good_reply=excluded.example_good_reply,
  priority=excluded.priority,
  is_active=true,
  prompt_group_key=excluded.prompt_group_key,
  updated_at=now();

create or replace function public.v8_dispatch_single_customer_profile_sync(p_page_id text,p_sender_id text)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_dispatch jsonb;
begin
  insert into public.v8_conversation_sync_queue(page_id,sender_id,priority,status,available_at,updated_at)
  values(p_page_id,p_sender_id,0,'pending',now(),now())
  on conflict(page_id,sender_id) do update set
    priority=0,
    status=case when public.v8_conversation_sync_queue.status='processing' then 'processing' else 'pending' end,
    available_at=now(),last_error=null,updated_at=now();
  v_dispatch:=public.v8_dispatch_meta_sync_batch(1);
  return jsonb_build_object('ok',true,'dispatch',v_dispatch,'page_id',p_page_id,'sender_id',p_sender_id);
end;
$$;

alter table public.v8_ai_brain_requests
  add column if not exists dispatch_locked_at timestamptz,
  add column if not exists dispatch_locked_by text,
  add column if not exists dispatch_details jsonb not null default '{}'::jsonb;

create index if not exists idx_v8_ai_brain_dispatch_claim
on public.v8_ai_brain_requests(status,dispatch_locked_at,created_at);

create or replace function public.v8_claim_ai_dispatch_batch(p_worker text,p_batch_size integer default 5)
returns table(id uuid,page_id text,sender_id text,message_id text)
language plpgsql
security definer
set search_path=public
as $$
begin
  return query
  with picked as (
    select r.id
    from public.v8_ai_brain_requests r
    where r.status in ('pending','error','processing')
      and r.decision_id is null
      and coalesce(r.attempts,0)<5
      and (r.dispatch_locked_at is null or r.dispatch_locked_at<now()-interval '2 minutes')
      and (r.status in ('pending','error') or r.started_at is null or r.started_at<now()-interval '2 minutes')
    order by r.created_at asc
    for update skip locked
    limit least(greatest(coalesce(p_batch_size,5),1),10)
  ), upd as (
    update public.v8_ai_brain_requests r
    set status='processing',dispatch_locked_at=now(),dispatch_locked_by=p_worker,
        started_at=coalesce(r.started_at,now()),last_error=null
    from picked p where r.id=p.id
    returning r.id,r.page_id,r.sender_id,r.message_id
  )
  select * from upd;
end;
$$;

create or replace function public.v8_finish_ai_dispatch(
  p_request_id uuid,p_worker text,p_success boolean,p_error text default null,p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  update public.v8_ai_brain_requests
  set dispatch_locked_at=null,dispatch_locked_by=null,
      dispatch_details=coalesce(dispatch_details,'{}'::jsonb)||coalesce(p_details,'{}'::jsonb)||jsonb_build_object('finished_at',now(),'worker',p_worker),
      status=case when status in ('completed','skipped') then status when p_success then status else 'error' end,
      last_error=case when status in ('completed','skipped') then last_error when p_success then last_error else left(coalesce(p_error,'AI_DISPATCH_FAILED'),1000) end
  where id=p_request_id and dispatch_locked_by=p_worker;
end;
$$;

create or replace function public.v8_enqueue_ai_brain_from_live_inbound()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare v_request_id uuid;
begin
  if new.direction<>'inbound' then return new; end if;
  if coalesce(new.source_system,'')<>'meta_customer' then return new; end if;
  if new.sent_at<now()-interval '2 minutes' then return new; end if;
  if coalesce(nullif(trim(new.message_text),''),'')=''
     and coalesce(jsonb_array_length(coalesce(new.attachments,'[]'::jsonb)),0)=0 then return new; end if;
  if not exists(select 1 from public.v8_ai_brain_runtime r where r.page_id=new.page_id and r.mode<>'OFF') then return new; end if;

  v_request_id:=public.v8_enqueue_ai_brain_request(new.page_id,new.sender_id,new.message_id,'live_inbound_profile_preflight');
  update public.v8_ai_brain_requests
  set status=case when status in ('error','skipped') then 'pending' else status end,
      dispatch_locked_at=null,dispatch_locked_by=null,
      last_error=case when status in ('error','skipped') then null else last_error end
  where id=v_request_id and status<>'completed';
  return new;
end;
$$;
