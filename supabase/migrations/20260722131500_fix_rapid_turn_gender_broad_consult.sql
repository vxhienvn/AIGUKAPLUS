-- Fix the Linh Luong incident structurally:
-- 1. Fresh inbound messages synchronized through Meta history are still live turns.
-- 2. Rapid postback selections are accumulated for four seconds and only the latest turn is dispatched.
-- 3. Admin-verified gender evidence must survive later profile updates.
-- 4. Broad gạch + nhà tắm + nhà bếp demand is handled contact-first without asking the same groups again.

create or replace function public.v8_admin_set_salutation(
  p_customer_id uuid,
  p_preferred_salutation text default null,
  p_gender text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sal text:=nullif(lower(btrim(coalesce(p_preferred_salutation,''))), '');
  v_gender text:=null;
  v_customer jsonb;
  v_resolved jsonb;
begin
  if v_sal is not null and v_sal not in ('anh','chị','cô','chú','em','bạn','quý khách') then
    raise exception 'invalid_salutation';
  end if;

  if lower(btrim(coalesce(p_gender,''))) in ('male','nam','man') then
    v_gender:='male';
  elsif lower(btrim(coalesce(p_gender,''))) in ('female','nữ','nu','woman') then
    v_gender:='female';
  elsif p_gender is not null and btrim(p_gender)<>'' then
    raise exception 'invalid_gender';
  elsif v_sal in ('anh','chú') then
    v_gender:='male';
  elsif v_sal in ('chị','cô') then
    v_gender:='female';
  end if;

  update public.v8_customers
     set preferred_salutation=v_sal,
         gender=case
           when v_gender is not null then v_gender
           when p_gender is not null then null
           else gender
         end,
         gender_source=case
           when v_gender is not null then 'admin_verified'
           when p_gender is not null then null
           else gender_source
         end,
         gender_synced_at=case
           when v_gender is not null then now()
           when p_gender is not null then null
           else gender_synced_at
         end
   where id=p_customer_id
   returning to_jsonb(v8_customers.*) into v_customer;

  select to_jsonb(r) into v_resolved
  from public.v8_resolve_customer_salutation(p_customer_id) r
  limit 1;

  return jsonb_build_object('customer',v_customer,'resolved',v_resolved);
end;
$function$;

update public.v8_customers
set gender_source='admin_verified'
where gender_source='manual';

create or replace function public.v8_enqueue_ai_brain_from_live_inbound()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_request_id uuid;
  v_cluster_start timestamptz;
  v_cluster_size integer:=1;
  v_cluster_message_ids jsonb:='[]'::jsonb;
  v_requested_by text;
begin
  if new.direction<>'inbound' then return new; end if;
  if coalesce(new.actor_type,'customer')<>'customer' then return new; end if;
  if coalesce(new.source_system,'') not in ('meta_customer','meta_customer_history') then return new; end if;
  if new.sent_at<now()-interval '3 minutes' then return new; end if;
  if coalesce(nullif(trim(new.message_text),''),'')=''
     and coalesce(jsonb_array_length(coalesce(new.attachments,'[]'::jsonb)),0)=0 then return new; end if;
  if not exists(
    select 1 from public.v8_ai_brain_runtime r
    where r.page_id=new.page_id and r.mode<>'OFF'
  ) then return new; end if;

  select min(m.sent_at),count(*)::integer,
         coalesce(jsonb_agg(m.message_id order by m.sent_at,m.created_at,m.id),'[]'::jsonb)
  into v_cluster_start,v_cluster_size,v_cluster_message_ids
  from public.v8_messages_raw m
  where m.page_id=new.page_id
    and m.sender_id=new.sender_id
    and m.direction='inbound'
    and coalesce(m.actor_type,'customer')='customer'
    and m.sent_at between new.sent_at-interval '20 seconds' and new.sent_at+interval '2 seconds';

  update public.v8_ai_brain_requests r
  set status='skipped',
      completed_at=now(),
      dispatch_locked_at=null,
      dispatch_locked_by=null,
      last_error='superseded_by_newer_customer_turn',
      dispatch_details=coalesce(r.dispatch_details,'{}'::jsonb)||jsonb_build_object(
        'superseded_by_message_id',new.message_id,
        'superseded_at',now(),
        'turn_cluster_start_at',v_cluster_start,
        'turn_cluster_size',v_cluster_size
      )
  where r.page_id=new.page_id
    and r.sender_id=new.sender_id
    and r.message_id<>new.message_id
    and r.requested_by<>'follow_up_scan'
    and r.status in ('pending','error')
    and r.decision_id is null
    and r.created_at>=now()-interval '3 minutes';

  v_requested_by:=case
    when new.source_system='meta_customer_history' then 'fresh_history_turn_debounced'
    else 'live_inbound_debounced'
  end;

  v_request_id:=public.v8_enqueue_ai_brain_request(
    new.page_id,new.sender_id,new.message_id,v_requested_by
  );

  update public.v8_ai_brain_requests
  set status=case when status in ('error','skipped') then 'pending' else status end,
      dispatch_locked_at=null,
      dispatch_locked_by=null,
      completed_at=case when status in ('error','skipped') then null else completed_at end,
      last_error=case when status in ('error','skipped') then null else last_error end,
      requested_by=v_requested_by,
      dispatch_details=coalesce(dispatch_details,'{}'::jsonb)||jsonb_build_object(
        'not_before',now()+interval '4 seconds',
        'turn_cluster_start_at',coalesce(v_cluster_start,new.sent_at),
        'turn_cluster_size',coalesce(v_cluster_size,1),
        'turn_cluster_message_ids',coalesce(v_cluster_message_ids,'[]'::jsonb),
        'turn_aggregation_mode','rapid_inbound_cumulative',
        'source_system',new.source_system,
        'latest_message_id',new.message_id
      )
  where id=v_request_id and decision_id is null;

  return new;
end;
$function$;

create or replace function public.v8_claim_ai_dispatch_batch(
  p_worker text,
  p_batch_size integer default 5
)
returns table(id uuid,page_id text,sender_id text,message_id text,requested_by text)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  return query
  with picked as (
    select r.id
    from public.v8_ai_brain_requests r
    where r.status in ('pending','error','processing')
      and r.decision_id is null
      and coalesce(r.attempts,0)<5
      and (
        nullif(r.dispatch_details->>'not_before','') is null
        or (r.dispatch_details->>'not_before')::timestamptz<=now()
      )
      and (
        r.dispatch_locked_at is null
        or r.dispatch_locked_at<now()-interval '2 minutes'
      )
      and (
        r.status in ('pending','error')
        or r.started_at is null
        or r.started_at<now()-interval '2 minutes'
      )
      and (
        r.requested_by='follow_up_scan'
        or not exists(
          select 1
          from public.v8_ai_brain_requests newer
          where newer.page_id=r.page_id
            and newer.sender_id=r.sender_id
            and newer.id<>r.id
            and newer.requested_by<>'follow_up_scan'
            and newer.decision_id is null
            and newer.status in ('pending','error','processing')
            and newer.created_at>r.created_at
            and newer.created_at<=r.created_at+interval '3 minutes'
        )
      )
    order by r.created_at asc
    for update skip locked
    limit least(greatest(coalesce(p_batch_size,5),1),10)
  ), upd as (
    update public.v8_ai_brain_requests r
    set status='processing',
        dispatch_locked_at=now(),
        dispatch_locked_by=p_worker,
        started_at=coalesce(r.started_at,now()),
        last_error=null
    from picked p
    where r.id=p.id
    returning r.id,r.page_id,r.sender_id,r.message_id,r.requested_by
  )
  select * from upd;
end;
$function$;

update public.v8_config_hub
set value=coalesce(value,'{}'::jsonb)||jsonb_build_object(
  'rapid_turn_debounce_seconds',4,
  'rapid_turn_cluster_seconds',20,
  'fresh_history_inbound_is_live',true,
  'latest_turn_priority',true,
  'updated_at',now()
),updated_at=now()
where key='follow_up_policy' and scope='conversation' and is_active;

do $migration$
declare
  v_learning_id uuid;
  v_customer_id uuid;
begin
  select id into v_customer_id
  from public.v8_customers
  where page_id='104810069068200' and sender_id='27574996888796147'
  limit 1;

  if v_customer_id is not null then
    perform public.v8_admin_set_salutation(v_customer_id,'anh','male');
  end if;

  select id into v_learning_id
  from public.v8_behavior_learning_cases
  where metadata->>'case_key'='linh_luong_rapid_multi_selection_contact_first_20260722'
  limit 1;

  if v_learning_id is null then
    insert into public.v8_behavior_learning_cases(
      page_id,sender_id,message_id,customer_message,bot_reply_before,improved_reply,
      context_summary,business_group_key,intent_type,conversation_stage,
      learning_scope,learning_type,status,reason,created_by,reviewed_by,reviewed_at,applied_at,metadata
    ) values(
      '104810069068200','27574996888796147','m_qw4Ju8GC0eztDV5tj9Sx-qX1B3Euus_OfIPH-hQvHTUXWJu2WzWFd5M42MotMU04KgM7sVYOXxPyjgy4FMi3iA',
      'Mình xin địa chỉ | Tư vấn nhà tắm/nhà bếp | Tư vấn gạch ốp lát',
      'Bên em là Tổng kho thiết bị bếp & nhà tắm toàn miền Bắc, có rất nhiều mẫu gạch ốp lát cho cả nhà tắm và nhà bếp nhé bạn. Để tư vấn sát nhất cho bạn, cho mình xin khu vực, tỉnh/thành và SĐT/Zalo...',
      'Dạ anh, showroom bên em tại 254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội. Các hạng mục anh đang quan tâm gồm gạch ốp lát, thiết bị nhà tắm và nhà bếp hiện có hơn 100 mẫu tham khảo. Để tiện lọc đúng mẫu và báo giá, anh cho em xin SĐT/Zalo, nhân viên bên em tư vấn trực tiếp và gửi mẫu phù hợp ạ.',
      'Khách bấm nhiều lựa chọn trong vài giây. Phải hiểu là nhu cầu cộng dồn gồm gạch, nhà tắm và nhà bếp; không chỉ lấy lựa chọn cuối, không hỏi lại các nhóm khách vừa chọn. Khách là nam đã được Admin xác minh.',
      'multi_product','ask_consult','high_intent_multi_selection',
      'similar_context','better_reply','applied',
      'Sửa lỗi phản hồi chậm do lịch sử đồng bộ không vào trigger tức thời; sửa cách hiểu chuỗi postback là nhu cầu tích lũy và ưu tiên xin liên hệ ngắn gọn.',
      'owner','owner',now(),now(),
      jsonb_build_object(
        'case_key','linh_luong_rapid_multi_selection_contact_first_20260722',
        'advisory_only',true,
        'do_not_hard_block',true,
        'decision_authority','ai',
        'rapid_selection_cluster_seconds',20,
        'requested_roots',jsonb_build_array('gach_ngoi','phong_tam','phong_bep'),
        'verified_image_snapshot',jsonb_build_object('gach_ngoi',29,'phong_tam',173,'phong_bep',42,'total',244,'captured_at',now()),
        'safe_inventory_phrase','hơn 100 mẫu tham khảo',
        'contact_first',true,
        'gender_admin_verified','male'
      )
    ) returning id into v_learning_id;
  else
    update public.v8_behavior_learning_cases
    set status='applied',
        improved_reply='Dạ anh, showroom bên em tại 254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội. Các hạng mục anh đang quan tâm gồm gạch ốp lát, thiết bị nhà tắm và nhà bếp hiện có hơn 100 mẫu tham khảo. Để tiện lọc đúng mẫu và báo giá, anh cho em xin SĐT/Zalo, nhân viên bên em tư vấn trực tiếp và gửi mẫu phù hợp ạ.',
        reviewed_by='owner',reviewed_at=now(),applied_at=now(),updated_at=now(),
        metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
          'advisory_only',true,'do_not_hard_block',true,'decision_authority','ai',
          'rapid_selection_cluster_seconds',20,
          'verified_image_snapshot',jsonb_build_object('gach_ngoi',29,'phong_tam',173,'phong_bep',42,'total',244,'captured_at',now()),
          'safe_inventory_phrase','hơn 100 mẫu tham khảo','contact_first',true,'gender_admin_verified','male'
        )
    where id=v_learning_id;
  end if;

  update public.v8_prompt_branches
  set branch_name='Nhiều lựa chọn liên tiếp — cộng dồn nhu cầu và xin liên hệ sớm',
      trigger_description='Khách bấm hoặc nhắn từ hai lựa chọn sản phẩm trở lên trong khoảng 20 giây, đặc biệt gạch, nhà tắm và nhà bếp.',
      conditions=jsonb_build_object(
        'scope','all_pages','architecture','ai_first','advisory_only',true,
        'do_not_hard_block',true,'decision_authority','ai',
        'rapid_inbound_cluster',true,'cluster_seconds',20,'contact_first',true
      ),
      instruction_text='Đây là kinh nghiệm tham khảo, AI quyết định cuối cùng. Khi khách bấm nhiều lựa chọn sản phẩm liên tiếp trong khoảng 20 giây, phải coi là nhu cầu CỘNG DỒN, không coi lựa chọn cuối thay thế các lựa chọn trước. Đọc toàn bộ cụm tin và xác nhận đủ các nhóm khách vừa chọn. Nếu khách chọn gạch ốp lát, nhà tắm và nhà bếp thì không hỏi lại khách cần nhóm nào. Hệ thống hiện có 29 hình mẫu gạch, 173 hình mẫu phòng tắm và 42 hình mẫu phòng bếp đã xác minh; để tránh đồng nhất số file ảnh với số mã sản phẩm, chỉ dùng cách nói bảo thủ “hơn 100 mẫu tham khảo”, trừ khi công cụ cung cấp số đếm mới hơn. Với lead nóng có nhu cầu rộng, ưu tiên xin SĐT/Zalo ngay bằng lợi ích lọc đúng mẫu, tư vấn trực tiếp và báo giá; không bắt khách trả lời thêm danh sách câu hỏi trước. Dùng đúng preferred_salutation. Nếu khách đồng thời xin địa chỉ, trả lời địa chỉ ngắn rồi chuyển ngay sang xác nhận các hạng mục và xin liên hệ.',
      example_customer_message='Mình xin địa chỉ | Tư vấn nhà tắm/nhà bếp | Tư vấn gạch ốp lát',
      example_good_reply='Dạ anh, showroom bên em tại 254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội. Các hạng mục anh đang quan tâm gồm gạch ốp lát, thiết bị nhà tắm và nhà bếp hiện có hơn 100 mẫu tham khảo. Để tiện lọc đúng mẫu và báo giá, anh cho em xin SĐT/Zalo, nhân viên bên em tư vấn trực tiếp và gửi mẫu phù hợp ạ.',
      priority=0,is_active=true,source_learning_case_id=v_learning_id,
      created_by='owner',updated_at=now(),prompt_group_key='learned_cases'
  where branch_key='ai_rapid_multi_selection_contact_first_v1';

  if not found then
    insert into public.v8_prompt_branches(
      branch_key,branch_name,trigger_description,conditions,instruction_text,
      example_customer_message,example_good_reply,priority,is_active,
      source_learning_case_id,created_by,prompt_group_key
    ) values(
      'ai_rapid_multi_selection_contact_first_v1',
      'Nhiều lựa chọn liên tiếp — cộng dồn nhu cầu và xin liên hệ sớm',
      'Khách bấm hoặc nhắn từ hai lựa chọn sản phẩm trở lên trong khoảng 20 giây, đặc biệt gạch, nhà tắm và nhà bếp.',
      jsonb_build_object(
        'scope','all_pages','architecture','ai_first','advisory_only',true,
        'do_not_hard_block',true,'decision_authority','ai',
        'rapid_inbound_cluster',true,'cluster_seconds',20,'contact_first',true
      ),
      'Đây là kinh nghiệm tham khảo, AI quyết định cuối cùng. Khi khách bấm nhiều lựa chọn sản phẩm liên tiếp trong khoảng 20 giây, phải coi là nhu cầu CỘNG DỒN, không coi lựa chọn cuối thay thế các lựa chọn trước. Đọc toàn bộ cụm tin và xác nhận đủ các nhóm khách vừa chọn. Nếu khách chọn gạch ốp lát, nhà tắm và nhà bếp thì không hỏi lại khách cần nhóm nào. Hệ thống hiện có 29 hình mẫu gạch, 173 hình mẫu phòng tắm và 42 hình mẫu phòng bếp đã xác minh; để tránh đồng nhất số file ảnh với số mã sản phẩm, chỉ dùng cách nói bảo thủ “hơn 100 mẫu tham khảo”, trừ khi công cụ cung cấp số đếm mới hơn. Với lead nóng có nhu cầu rộng, ưu tiên xin SĐT/Zalo ngay bằng lợi ích lọc đúng mẫu, tư vấn trực tiếp và báo giá; không bắt khách trả lời thêm danh sách câu hỏi trước. Dùng đúng preferred_salutation. Nếu khách đồng thời xin địa chỉ, trả lời địa chỉ ngắn rồi chuyển ngay sang xác nhận các hạng mục và xin liên hệ.',
      'Mình xin địa chỉ | Tư vấn nhà tắm/nhà bếp | Tư vấn gạch ốp lát',
      'Dạ anh, showroom bên em tại 254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội. Các hạng mục anh đang quan tâm gồm gạch ốp lát, thiết bị nhà tắm và nhà bếp hiện có hơn 100 mẫu tham khảo. Để tiện lọc đúng mẫu và báo giá, anh cho em xin SĐT/Zalo, nhân viên bên em tư vấn trực tiếp và gửi mẫu phù hợp ạ.',
      0,true,v_learning_id,'owner','learned_cases'
    );
  end if;
end;
$migration$;
