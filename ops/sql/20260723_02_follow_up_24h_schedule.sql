-- Run AI-governed follow-up continuously instead of deferring all overnight
-- conversations to 08:15. A completed AI decline is terminal for that latest
-- customer turn, preventing a permanent candidate/on-conflict loop.

begin;

update public.v8_config_hub
set value=coalesce(value,'{}'::jsonb)||jsonb_build_object(
      'quiet_hours_enabled',false,
      'timing_summary','24/24: daytime 4h hot / 5h general; evening and overnight 2h hot / 3h general',
      'scan_interval_minutes',2,
      'policy_version','dynamic_follow_up_v9_24h',
      'updated_at',now()
    ),updated_at=now()
where key='follow_up_policy' and scope='conversation' and is_active;

create or replace function public.v8_follow_up_schedule(
  p_anchor timestamptz,
  p_hot boolean default false,
  p_contact_requested boolean default false,
  p_policy jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
set search_path='public'
as $$
declare
  v_tz text:=coalesce(nullif(p_policy->>'timezone',''),'Asia/Bangkok');
  v_day_start integer:=least(greatest(coalesce((p_policy->>'day_start_hour')::integer,8),0),23);
  v_evening_start integer:=least(greatest(coalesce((p_policy->>'evening_start_hour')::integer,18),0),23);
  v_quiet_start integer:=least(greatest(coalesce((p_policy->>'quiet_start_hour')::integer,22),0),23);
  v_resume_hour integer:=least(greatest(coalesce((p_policy->>'quiet_resume_hour')::integer,8),0),23);
  v_resume_minute integer:=least(greatest(coalesce((p_policy->>'quiet_resume_minute')::integer,15),0),59);
  v_quiet_enabled boolean:=coalesce((p_policy->>'quiet_hours_enabled')::boolean,false);
  v_day_hot integer:=least(greatest(coalesce((p_policy->>'daytime_hot_hours')::integer,4),1),12);
  v_day_general integer:=least(greatest(coalesce((p_policy->>'daytime_general_hours')::integer,5),1),12);
  v_evening_hot integer:=least(greatest(coalesce((p_policy->>'evening_hot_hours')::integer,2),1),12);
  v_evening_general integer:=least(greatest(coalesce((p_policy->>'evening_general_hours')::integer,3),1),12);
  v_local_anchor timestamp;
  v_due_local timestamp;
  v_due timestamptz;
  v_anchor_hour integer;
  v_due_hour integer;
  v_delay integer:=0;
  v_daypart text;
  v_quiet_deferred boolean:=false;
  v_is_hot boolean:=coalesce(p_hot,false) or coalesce(p_contact_requested,false);
begin
  if p_anchor is null then
    return jsonb_build_object('due_at',null,'daypart','unknown','delay_hours',null,'quiet_hours_deferred',false,'timezone',v_tz);
  end if;

  v_local_anchor:=p_anchor at time zone v_tz;
  v_anchor_hour:=extract(hour from v_local_anchor)::integer;

  if v_quiet_enabled and (v_anchor_hour>=v_quiet_start or v_anchor_hour<v_day_start) then
    v_daypart:='quiet';
    v_quiet_deferred:=true;
    if v_anchor_hour<v_day_start then
      v_due_local:=date_trunc('day',v_local_anchor)+make_interval(hours=>v_resume_hour,mins=>v_resume_minute);
    else
      v_due_local:=date_trunc('day',v_local_anchor)+interval '1 day'+make_interval(hours=>v_resume_hour,mins=>v_resume_minute);
    end if;
  else
    if v_anchor_hour>=v_evening_start or v_anchor_hour<v_day_start then
      v_daypart:=case when v_anchor_hour<v_day_start then 'overnight' else 'evening' end;
      v_delay:=case when v_is_hot then v_evening_hot else v_evening_general end;
    else
      v_daypart:='daytime';
      v_delay:=case when v_is_hot then v_day_hot else v_day_general end;
    end if;
    v_due_local:=v_local_anchor+make_interval(hours=>v_delay);

    if v_quiet_enabled then
      v_due_hour:=extract(hour from v_due_local)::integer;
      if v_due_hour>=v_quiet_start or v_due_hour<v_day_start then
        v_quiet_deferred:=true;
        if v_due_hour<v_day_start then
          v_due_local:=date_trunc('day',v_due_local)+make_interval(hours=>v_resume_hour,mins=>v_resume_minute);
        else
          v_due_local:=date_trunc('day',v_due_local)+interval '1 day'+make_interval(hours=>v_resume_hour,mins=>v_resume_minute);
        end if;
      end if;
    end if;
  end if;

  v_due:=v_due_local at time zone v_tz;
  return jsonb_build_object(
    'due_at',v_due,'due_local',to_char(v_due_local,'YYYY-MM-DD HH24:MI:SS'),
    'daypart',v_daypart,'delay_hours',v_delay,'quiet_hours_deferred',v_quiet_deferred,
    'quiet_hours_enabled',v_quiet_enabled,'timezone',v_tz,'hot_intent',v_is_hot
  );
end;
$$;

create or replace function public.v8_create_follow_up_tasks(
  p_limit integer default 100,
  p_dry_run boolean default true,
  p_requested_by text default 'manual_test'
)
returns jsonb
language plpgsql
security definer
set search_path='public'
as $$
declare
  v_cfg jsonb:='{}'::jsonb;
  v_enabled boolean:=true;
  v_limit integer:=least(greatest(coalesce(p_limit,100),1),500);
  v_lookback integer:=24;
  v_scan_interval integer:=2;
  v_candidate_count integer:=0;
  v_requests_created integer:=0;
  v_row_count integer:=0;
  v_items jsonb:='[]'::jsonb;
  v_request_message_id text;
  r record;
begin
  select value into v_cfg from public.v8_config_hub
  where key='follow_up_policy' and scope='conversation' and is_active
  order by updated_at desc limit 1;

  v_cfg:=coalesce(v_cfg,'{}'::jsonb);
  v_enabled:=coalesce((v_cfg->>'enabled')::boolean,true)
             and coalesce((v_cfg->>'scheduler_enabled')::boolean,true);
  v_lookback:=least(greatest(coalesce((v_cfg->>'scan_lookback_hours')::integer,24),1),48);
  v_scan_interval:=least(greatest(coalesce((v_cfg->>'scan_interval_minutes')::integer,2),1),60);

  if not v_enabled then
    return jsonb_build_object('enabled',false,'dry_run',p_dry_run,'candidates',0,
      'tasks_created',0,'ai_requests_created',0,'items','[]'::jsonb);
  end if;

  for r in
    with base as (
      select c.id customer_id,c.page_id,c.sender_id,c.display_name,
        coalesce(q.product_key,c.last_product_key,rp0.business_group_key) group_key,
        coalesce(bg.group_name,'sản phẩm') group_name,
        coalesce(q.intent_type,c.last_intent_type) effective_intent,
        m_in.message_id last_inbound_message_id,m_in.message_text last_inbound_text,m_in.sent_at last_inbound_at,
        ext.last_external_at,ext.last_external_message_id,ext.last_external_text,
        bot.last_bot_at,bot.last_bot_message_id,pol.runtime_mode
      from public.v8_customers c
      join public.v8_conversation_states s on s.customer_id=c.id
      join public.v8_messages_raw m_in on m_in.page_id=c.page_id and m_in.message_id=s.last_inbound_message_id and m_in.direction='inbound'
      join lateral public.v8_resolve_runtime_policy(c.page_id) pol on true
      left join lateral (
        select pq.* from public.v8_processing_queue pq
        where pq.page_id=c.page_id and pq.message_id=m_in.message_id order by pq.created_at desc limit 1
      ) q on true
      left join lateral (
        select rp.* from public.v8_reply_plans rp
        where rp.customer_id=c.id and rp.message_id=m_in.message_id order by rp.created_at desc limit 1
      ) rp0 on true
      left join public.v8_business_product_groups bg on bg.group_key=coalesce(q.product_key,c.last_product_key,rp0.business_group_key)
      left join lateral (
        select max(m.sent_at) last_external_at,
          (array_agg(m.message_id order by m.sent_at desc,m.created_at desc))[1] last_external_message_id,
          (array_agg(m.message_text order by m.sent_at desc,m.created_at desc))[1] last_external_text
        from public.v8_messages_raw m
        where m.customer_id=c.id and m.direction='outbound' and m.sent_at>m_in.sent_at
          and public.v8_is_actionable_external_outbound(m.source_system,m.message_text,m.attachments,m.is_automatic,m.actor_type,m.source_detail)
      ) ext on true
      left join lateral (
        select max(m.sent_at) last_bot_at,
          (array_agg(m.message_id order by m.sent_at desc,m.created_at desc))[1] last_bot_message_id
        from public.v8_messages_raw m
        where m.customer_id=c.id and m.direction='outbound' and m.sent_at>m_in.sent_at
          and coalesce(m.source_system,'') in ('aiguka','aiguka_v8')
      ) bot on true
      where c.phone is null and c.zalo is null and not coalesce(s.has_phone,false)
        and coalesce(s.stage,'')<>'suppressed'
        and not (coalesce(s.follow_up_suppressed_until,'epoch'::timestamptz)>now())
        and coalesce(s.follow_up_suppression_reason,'')<>'customer_opt_out'
        and m_in.sent_at>=now()-make_interval(hours=>v_lookback)
        and coalesce(c.last_intent_type,'') not in ('provide_contact','decline','decline_contact','decline_interest','acknowledge')
        and coalesce(pol.can_send_text,false)
    ), classified as (
      select b.*,
        (coalesce(b.effective_intent,'') in (
          'ask_sample','ask_price','purchase_intent','buy_now','ask_showroom','ask_address','ask_transport',
          'ask_shipping','ask_combo','lead_qualification','hot_lead'
        ) or coalesce(b.last_inbound_text,'') ~* '(xem|gửi|xin)[[:space:]]*(mẫu|catalog|hình|ảnh)|báo[[:space:]]*giá|giá[[:space:]]*(bao nhiêu|bn)|mua|đặt|combo|showroom|cửa[[:space:]]*hàng|địa[[:space:]]*chỉ|vận[[:space:]]*chuyển|ship') hot_intent,
        (coalesce(b.last_external_text,'') ~* '(sđt|sdt|số[[:space:]]*điện[[:space:]]*thoại|số[[:space:]]*zalo|zalo|phone|liên[[:space:]]*hệ)') contact_requested,
        (coalesce(b.effective_intent,'')='ask_sample' or coalesce(b.last_inbound_text,'') ~* '(xem|gửi|xin)[[:space:]]*(mẫu|catalog|hình|ảnh)') customer_requested_sample,
        case when b.last_bot_at is not null and (b.last_external_at is null or b.last_bot_at>=b.last_external_at) then b.last_bot_at
             when b.last_external_at is not null then b.last_external_at else b.last_inbound_at end care_anchor_at,
        case when b.last_bot_at is not null and (b.last_external_at is null or b.last_bot_at>=b.last_external_at) then b.last_bot_message_id
             when b.last_external_at is not null then b.last_external_message_id else b.last_inbound_message_id end care_anchor_message_id,
        case
          when b.last_external_at is not null and (b.last_bot_at is null or b.last_external_at>b.last_bot_at)
               and coalesce(b.last_external_text,'') ~* '(sđt|sdt|số[[:space:]]*điện[[:space:]]*thoại|số[[:space:]]*zalo|zalo|phone|liên[[:space:]]*hệ)'
            then 'human_contact_request_no_response'
          when b.last_bot_at is not null and (b.last_external_at is null or b.last_bot_at>=b.last_external_at) then 'bot_silence_dynamic'
          when b.last_external_at is not null then 'sale_silence_dynamic'
          else 'customer_unanswered_dynamic'
        end care_case
      from base b
    ), scheduled as (
      select c.*,public.v8_follow_up_schedule(c.care_anchor_at,c.hot_intent,c.contact_requested,v_cfg) schedule from classified c
    )
    select x.*,nullif(x.schedule->>'due_at','')::timestamptz due_at,
      x.schedule->>'daypart' follow_up_daypart,
      coalesce((x.schedule->>'delay_hours')::integer,0) follow_up_delay_hours,
      coalesce((x.schedule->>'quiet_hours_deferred')::boolean,false) quiet_hours_deferred
    from scheduled x
    where x.care_case is not null and nullif(x.schedule->>'due_at','')::timestamptz<=now()
      and not exists(select 1 from public.v8_outbound_queue oq where oq.customer_id=x.customer_id and oq.status in ('planned','ready','sending'))
      and not exists(select 1 from public.v8_ai_brain_requests ar where ar.page_id=x.page_id and ar.message_id=x.last_inbound_message_id
                     and ar.requested_by<>'follow_up_scan' and ar.status in ('pending','processing','error'))
      and not exists(select 1 from public.v8_ai_decisions ad where ad.page_id=x.page_id and ad.message_id=x.last_inbound_message_id
                     and ad.status in ('revision_required','processing'))
      and not exists(select 1 from public.v8_ai_brain_requests fr
                     where fr.page_id=x.page_id and fr.sender_id=x.sender_id and fr.requested_by='follow_up_scan'
                       and fr.status='completed' and fr.dispatch_details->>'last_inbound_message_id'=x.last_inbound_message_id)
    order by due_at,x.last_inbound_at limit v_limit
  loop
    v_request_message_id:='care2:'||r.customer_id::text||':'||md5(coalesce(r.care_anchor_message_id,'')||':'||r.care_case||':'||coalesce(r.follow_up_daypart,''));
    v_candidate_count:=v_candidate_count+1;
    v_items:=v_items||jsonb_build_array(jsonb_build_object(
      'customer_id',r.customer_id,'page_id',r.page_id,'sender_id',r.sender_id,'display_name',r.display_name,
      'care_case',r.care_case,'last_inbound_message_id',r.last_inbound_message_id,'last_inbound_at',r.last_inbound_at,
      'care_anchor_at',r.care_anchor_at,'care_anchor_message_id',r.care_anchor_message_id,'due_at',r.due_at,
      'follow_up_daypart',r.follow_up_daypart,'follow_up_delay_hours',r.follow_up_delay_hours,
      'quiet_hours_deferred',r.quiet_hours_deferred,'hot_intent',r.hot_intent,'contact_requested',r.contact_requested,
      'customer_requested_sample',r.customer_requested_sample,'group_key',r.group_key,'group_name',r.group_name,
      'ai_request_message_id',v_request_message_id
    ));

    if not p_dry_run then
      insert into public.v8_ai_brain_requests(page_id,sender_id,message_id,status,requested_by,dispatch_details)
      values(r.page_id,r.sender_id,v_request_message_id,'pending','follow_up_scan',jsonb_build_object(
        'trigger_type','dynamic_follow_up','care_case',r.care_case,'care_anchor_at',r.care_anchor_at,
        'care_anchor_message_id',r.care_anchor_message_id,'last_inbound_message_id',r.last_inbound_message_id,
        'last_inbound_at',r.last_inbound_at,'group_key',r.group_key,'group_name',r.group_name,'due_at',r.due_at,
        'follow_up_daypart',r.follow_up_daypart,'follow_up_delay_hours',r.follow_up_delay_hours,
        'quiet_hours_deferred',r.quiet_hours_deferred,'hot_intent',r.hot_intent,'contact_requested',r.contact_requested,
        'customer_requested_sample',r.customer_requested_sample,
        'allow_slide_follow_up',coalesce((v_cfg->>'allow_slide_follow_up')::boolean,true),
        'allow_benefit_hint',coalesce((v_cfg->>'allow_benefit_hint')::boolean,true),
        'requested_by',coalesce(nullif(p_requested_by,''),'system'),'policy',v_cfg
      )) on conflict(page_id,message_id) do nothing;
      get diagnostics v_row_count=row_count;
      v_requests_created:=v_requests_created+v_row_count;
    end if;
  end loop;

  return jsonb_build_object(
    'enabled',true,'dry_run',p_dry_run,'requested_by',p_requested_by,
    'scan_interval_minutes',v_scan_interval,
    'timing_summary',coalesce(v_cfg->>'timing_summary','24/24 dynamic follow-up'),
    'quiet_hours_enabled',coalesce((v_cfg->>'quiet_hours_enabled')::boolean,false),
    'decision_authority','ai_follow_up_brain','slide_follow_up_enabled',coalesce((v_cfg->>'allow_slide_follow_up')::boolean,true),
    'lookback_hours',v_lookback,'limit',v_limit,'candidates',v_candidate_count,
    'tasks_created',0,'reply_plans_created',0,'ai_requests_created',v_requests_created,'items',v_items
  );
end;
$$;

commit;
