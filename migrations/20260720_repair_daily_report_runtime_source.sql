-- Daily Report runtime repair: actual Meta/customer activity for every Page,
-- one ad attribution per customer/day, correct VN dates, Ads Insights merged when available.

create or replace view public.v8_dashboard_daily_metrics_raw as
with days as (
  select generate_series(
    (timezone('Asia/Ho_Chi_Minh',now())::date - 89)::timestamp,
    timezone('Asia/Ho_Chi_Minh',now())::date::timestamp,
    interval '1 day'
  )::date as metric_date
), pages as (
  select page_id,page_name from public.v8_pages where is_active=true
)
select d.metric_date,p.page_id,p.page_name,
  (select count(*) from public.v8_messages_raw m
   where m.page_id=p.page_id
     and timezone('Asia/Ho_Chi_Minh',coalesce(m.sent_at,m.created_at))::date=d.metric_date
     and coalesce(m.direction,'inbound')='inbound'
     and coalesce(m.actor_type,'customer')='customer') as messages,
  (select count(distinct m.sender_id) from public.v8_messages_raw m
   where m.page_id=p.page_id
     and timezone('Asia/Ho_Chi_Minh',coalesce(m.sent_at,m.created_at))::date=d.metric_date
     and coalesce(m.direction,'inbound')='inbound'
     and coalesce(m.actor_type,'customer')='customer') as customers,
  (select count(*) from public.v8_lead_events le
   where le.page_id=p.page_id and timezone('Asia/Ho_Chi_Minh',le.created_at)::date=d.metric_date) as lead_events,
  (select count(distinct coalesce(le.customer_id::text,le.sender_id))
   from public.v8_lead_events le
   where le.page_id=p.page_id
     and timezone('Asia/Ho_Chi_Minh',le.created_at)::date=d.metric_date
     and (le.phone is not null or le.zalo is not null or le.event_type in ('phone_detected','zalo_detected','provide_contact'))) as contacts,
  (select count(*) from public.v8_sale_tasks st
   where st.page_id=p.page_id and timezone('Asia/Ho_Chi_Minh',st.created_at)::date=d.metric_date) as sale_tasks,
  (select count(*) from public.v8_slide_logs sl
   where sl.page_id=p.page_id and timezone('Asia/Ho_Chi_Minh',sl.created_at)::date=d.metric_date) as slides
from days d cross join pages p;

create or replace view public.v8_report_daily_runtime_detail as
with inbound as (
  select m.customer_id,m.page_id,m.sender_id,
    coalesce(m.sent_at,m.created_at) as event_at,
    timezone('Asia/Ho_Chi_Minh',coalesce(m.sent_at,m.created_at))::date as report_date
  from public.v8_messages_raw m
  where m.direction='inbound' and coalesce(m.actor_type,'customer')='customer'
    and m.page_id is not null and m.sender_id is not null
), customer_day as (
  select report_date,page_id,sender_id,
    (array_agg(customer_id order by event_at) filter(where customer_id is not null))[1] as customer_id,
    min(event_at) as first_event_at,count(*)::bigint as message_count
  from inbound group by report_date,page_id,sender_id
), attributed as (
  select cd.*,p.tenant_id,p.page_name,ref.ad_id,
    coalesce(map.ad_account_id,aa.ad_account_id) as ad_account_id,
    coalesce(map.ad_account_name,aa.ad_account_name) as ad_account_name,
    coalesce(map.campaign_id,ctx.campaign_id) as campaign_id,
    coalesce(map.campaign_name,ctx.campaign_name) as campaign_name,
    coalesce(map.adset_id,ctx.adset_id) as adset_id,
    coalesce(map.adset_name,ctx.adset_name) as adset_name,
    coalesce(map.ad_name,ctx.ad_name) as ad_name,
    coalesce(map.effective_status,'UNKNOWN') as effective_status,
    coalesce(aa.currency,'VND') as currency,
    coalesce(aa.reporting_timezone,aa.timezone_name,'Asia/Ho_Chi_Minh') as account_timezone,
    aa.payment_method_last4,
    exists(
      select 1 from public.v8_lead_events le
      where le.page_id=cd.page_id and (le.customer_id=cd.customer_id or le.sender_id=cd.sender_id)
        and timezone('Asia/Ho_Chi_Minh',le.created_at)::date=cd.report_date
        and (le.phone is not null or le.zalo is not null or le.event_type in ('phone_detected','zalo_detected','provide_contact'))
    ) as has_contact,
    coalesce(c.lead_state='hot_lead',false) as is_hot_lead
  from customer_day cd
  join public.v8_pages p on p.page_id=cd.page_id
  left join public.v8_customers c on c.id=cd.customer_id
  left join lateral (
    select r.ad_id from public.v8_meta_ad_referral_entries r
    where r.page_id=cd.page_id and (r.sender_id=cd.sender_id or r.customer_id=cd.customer_id)
      and r.referral_at<=cd.first_event_at+interval '10 minutes'
      and r.referral_at>=cd.first_event_at-interval '90 days'
    order by r.referral_at desc limit 1
  ) ref on true
  left join lateral (
    select m.* from public.ad_mappings m where m.ad_id=ref.ad_id
    order by coalesce(m.is_active,m.enabled,true) desc,m.updated_at desc nulls last,m.id desc limit 1
  ) map on true
  left join lateral (
    select x.* from public.v8_ad_context x where x.page_id=cd.page_id and x.ad_id=ref.ad_id
    order by x.is_active desc,x.updated_at desc limit 1
  ) ctx on true
  left join public.v8_meta_ad_accounts aa on aa.ad_account_id=map.ad_account_id
), crm as (
  select tenant_id,report_date,page_id,max(page_name) as page_name,
    ad_account_id,max(ad_account_name) as ad_account_name,
    campaign_id,max(campaign_name) as campaign_name,
    adset_id,max(adset_name) as adset_name,
    ad_id,max(ad_name) as ad_name,max(effective_status) as effective_status,
    max(currency) as currency,max(account_timezone) as account_timezone,
    max(payment_method_last4) as payment_method_last4,
    count(*)::bigint as conversations,
    count(*) filter(where has_contact)::bigint as contacts,
    count(*) filter(where is_hot_lead)::bigint as hot_leads,
    sum(message_count)::bigint as message_count
  from attributed
  group by tenant_id,report_date,page_id,ad_account_id,campaign_id,adset_id,ad_id
), ad_page as (
  select distinct on (r.ad_id) r.ad_id,r.page_id
  from public.v8_meta_ad_referral_entries r where r.ad_id is not null
  order by r.ad_id,r.referral_at desc
), ads as (
  select ai.tenant_id,ai.insight_date as report_date,coalesce(ai.page_id,ap.page_id) as page_id,
    ai.ad_account_id,ai.campaign_id,max(ai.campaign_name) as campaign_name,
    ai.adset_id,max(ai.adset_name) as adset_name,ai.ad_id,max(ai.ad_name) as ad_name,
    max(ai.effective_status) as effective_status,max(ai.currency) as currency,
    max(ai.account_timezone) as account_timezone,
    sum(ai.spend)::numeric(18,2) as spend,sum(ai.tax_amount)::numeric(18,2) as tax_amount,
    sum(case when ai.spend_with_tax>0 then ai.spend_with_tax else ai.spend end)::numeric(18,2) as spend_with_tax,
    sum(ai.impressions)::bigint as impressions,sum(ai.reach)::bigint as reach,
    sum(ai.clicks)::bigint as clicks,sum(ai.link_clicks)::bigint as link_clicks,
    sum(ai.messaging_conversations_started)::bigint as meta_conversations,
    sum(ai.meta_leads)::bigint as meta_leads
  from public.v8_ads_daily_insights ai left join ad_page ap on ap.ad_id=ai.ad_id
  group by ai.tenant_id,ai.insight_date,coalesce(ai.page_id,ap.page_id),ai.ad_account_id,ai.campaign_id,ai.adset_id,ai.ad_id
)
select coalesce(crm.tenant_id,ads.tenant_id,p.tenant_id) as tenant_id,
  coalesce(crm.report_date,ads.report_date) as report_date,
  coalesce(crm.page_id,ads.page_id) as page_id,coalesce(crm.page_name,p.page_name) as page_name,
  coalesce(crm.ad_account_id,ads.ad_account_id) as ad_account_id,
  coalesce(crm.ad_account_name,aa.ad_account_name,case when coalesce(crm.ad_account_id,ads.ad_account_id) is null then 'Chưa xác định tài khoản QC' end) as ad_account_name,
  coalesce(crm.campaign_id,ads.campaign_id) as campaign_id,coalesce(crm.campaign_name,ads.campaign_name) as campaign_name,
  coalesce(crm.adset_id,ads.adset_id) as adset_id,coalesce(crm.adset_name,ads.adset_name) as adset_name,
  coalesce(crm.ad_id,ads.ad_id) as ad_id,coalesce(crm.ad_name,ads.ad_name) as ad_name,
  coalesce(crm.effective_status,ads.effective_status,'UNKNOWN') as effective_status,
  coalesce(ads.currency,crm.currency,aa.currency,'VND') as currency,
  coalesce(ads.account_timezone,crm.account_timezone,aa.reporting_timezone,aa.timezone_name,'Asia/Ho_Chi_Minh') as account_timezone,
  coalesce(ads.spend,0)::numeric(18,2) as spend,coalesce(ads.tax_amount,0)::numeric(18,2) as tax_amount,
  coalesce(ads.spend_with_tax,ads.spend,0)::numeric(18,2) as spend_with_tax,
  coalesce(ads.impressions,0)::bigint as impressions,coalesce(ads.reach,0)::bigint as reach,
  coalesce(ads.clicks,0)::bigint as clicks,coalesce(ads.link_clicks,0)::bigint as link_clicks,
  coalesce(ads.meta_conversations,0)::bigint as meta_conversations,
  coalesce(crm.conversations,0)::bigint as conversations,coalesce(crm.contacts,0)::bigint as contacts,
  coalesce(crm.hot_leads,0)::bigint as hot_leads,coalesce(crm.message_count,0)::bigint as message_count,
  coalesce(ads.meta_leads,0)::bigint as meta_leads,
  case when coalesce(crm.conversations,0)>0 then round(coalesce(crm.contacts,0)::numeric*100/coalesce(crm.conversations,1),2) else 0::numeric end as contact_rate,
  case when coalesce(crm.conversations,0)>0 then round(coalesce(ads.spend_with_tax,ads.spend,0)/coalesce(crm.conversations,1),2) else 0::numeric end as cost_per_conversation,
  case when coalesce(crm.contacts,0)>0 then round(coalesce(ads.spend_with_tax,ads.spend,0)/coalesce(crm.contacts,1),2) else 0::numeric end as cost_per_contact,
  coalesce(crm.payment_method_last4,aa.payment_method_last4) as payment_method_last4,
  case when crm.report_date is not null and ads.report_date is not null then 'matched'
       when crm.report_date is not null and crm.ad_id is null then 'runtime_unattributed'
       when crm.report_date is not null then 'runtime_crm_only' else 'ads_only' end as data_match_status
from crm full join ads
  on crm.report_date=ads.report_date
 and coalesce(crm.page_id,'')=coalesce(ads.page_id,'')
 and coalesce(crm.ad_account_id,'')=coalesce(ads.ad_account_id,'')
 and coalesce(crm.ad_id,'')=coalesce(ads.ad_id,'')
left join public.v8_pages p on p.page_id=coalesce(crm.page_id,ads.page_id)
left join public.v8_meta_ad_accounts aa on aa.ad_account_id=coalesce(crm.ad_account_id,ads.ad_account_id);

create or replace function public.v8_report_daily_test(
  p_from date default current_date,p_to date default current_date,p_page_id text default null,
  p_ad_account_id text default null,p_campaign_id text default null,p_adset_id text default null,
  p_ad_id text default null,p_search text default null,p_limit integer default 100,p_offset integer default 0
) returns jsonb language plpgsql security definer set search_path='public' as $function$
declare v_result jsonb;
begin
  perform public.v8_assert_admin_request();
  with src as (
    select * from public.v8_report_daily_runtime_detail r
    where r.report_date between coalesce(p_from,current_date) and coalesce(p_to,current_date)
      and (nullif(btrim(p_page_id),'') is null or r.page_id=p_page_id)
      and (nullif(btrim(p_ad_account_id),'') is null or r.ad_account_id=replace(p_ad_account_id,'act_',''))
      and (nullif(btrim(p_campaign_id),'') is null or r.campaign_id=p_campaign_id)
      and (nullif(btrim(p_adset_id),'') is null or r.adset_id=p_adset_id)
      and (nullif(btrim(p_ad_id),'') is null or r.ad_id=p_ad_id)
      and (nullif(btrim(p_search),'') is null or concat_ws(' ',r.page_name,r.ad_name,r.ad_id,r.campaign_name,r.adset_name,r.ad_account_name) ilike '%'||btrim(p_search)||'%')
  ), agg as (
    select report_date,page_id,max(page_name) as page_name,ad_account_id,max(ad_account_name) as ad_account_name,
      max(currency) as currency,max(account_timezone) as account_timezone,max(payment_method_last4) as payment_method_last4,
      coalesce(sum(spend),0) as spend,coalesce(sum(tax_amount),0) as tax_amount,coalesce(sum(spend_with_tax),0) as spend_with_tax,
      coalesce(sum(impressions),0) as impressions,coalesce(sum(reach),0) as reach,coalesce(sum(clicks),0) as clicks,
      coalesce(sum(link_clicks),0) as link_clicks,coalesce(sum(meta_conversations),0) as meta_conversations,
      coalesce(sum(conversations),0) as conversations,coalesce(sum(contacts),0) as contacts,
      coalesce(sum(hot_leads),0) as hot_leads,coalesce(sum(message_count),0) as message_count,
      coalesce(sum(meta_leads),0) as meta_leads,bool_or(data_match_status like 'runtime%') as has_runtime_data,
      bool_or(data_match_status in ('matched','ads_only')) as has_ads_data
    from src group by report_date,page_id,ad_account_id
  ), final as (
    select agg.*,
      case when conversations>0 then round(contacts*100.0/conversations,2) else 0 end as contact_rate,
      case when conversations>0 then round(spend_with_tax/conversations,2) else 0 end as cost_per_conversation,
      case when contacts>0 then round(spend_with_tax/contacts,2) else 0 end as cost_per_contact,
      case when has_ads_data then 'Meta Ads + hội thoại thực' else 'Hội thoại thực; Ads Insights chưa đồng bộ' end as data_status
    from agg
  ), paged as (
    select * from final order by report_date desc,page_name,ad_account_name
    limit least(greatest(coalesce(p_limit,100),1),10000) offset greatest(coalesce(p_offset,0),0)
  )
  select jsonb_build_object(
    'ok',true,
    'data',coalesce((select jsonb_agg(to_jsonb(p) order by p.report_date desc,p.page_name,p.ad_account_name) from paged p),'[]'::jsonb),
    'count',(select count(*) from final),
    'warnings',case when exists(select 1 from public.v8_ads_daily_insights where insight_date between coalesce(p_from,current_date) and coalesce(p_to,current_date)) then '[]'::jsonb else '["ADS_INSIGHTS_NOT_SYNCED"]'::jsonb end,
    'range',jsonb_build_object('from',coalesce(p_from,current_date),'to',coalesce(p_to,current_date))
  ) into v_result;
  return v_result;
end;$function$;

grant select on public.v8_report_daily_runtime_detail to anon,authenticated,service_role;
grant execute on function public.v8_report_daily_test(date,date,text,text,text,text,text,text,integer,integer) to anon,authenticated,service_role;
