insert into public.v8_meta_page_ad_accounts(page_id,ad_account_id,is_primary,purpose,updated_at)
values
 ('985632314640803','311242249583664',true,'reporting',now()),
 ('104810069068200','972318199015585',true,'reporting',now())
on conflict (page_id,ad_account_id) do update
set is_primary=excluded.is_primary,purpose=excluded.purpose,updated_at=now();

create or replace view public.v8_report_ad_performance_daily as
select
 d.tenant_id,
 d.report_date,
 d.page_id,
 d.page_name,
 coalesce(d.ad_account_id,pa.ad_account_id) as ad_account_id,
 case when d.ad_account_id is null
      then coalesce(fa.ad_account_name,'Chưa xác định tài khoản QC')
      else d.ad_account_name end as ad_account_name,
 d.campaign_id,
 d.campaign_name,
 d.adset_id,
 d.adset_name,
 d.ad_id,
 d.ad_name,
 d.effective_status,
 coalesce(d.currency,fa.currency,'VND') as currency,
 coalesce(d.account_timezone,fa.reporting_timezone,fa.timezone_name,'Asia/Ho_Chi_Minh') as account_timezone,
 d.spend,
 d.tax_amount,
 d.spend_with_tax,
 d.impressions,
 d.reach,
 d.clicks,
 d.link_clicks,
 d.meta_conversations,
 d.conversations,
 d.contacts,
 d.hot_leads,
 d.message_count,
 d.meta_leads,
 d.contact_rate,
 d.cost_per_conversation,
 d.cost_per_contact,
 coalesce(d.payment_method_last4,fa.payment_method_last4) as payment_method_last4,
 case when d.ad_account_id is null and pa.ad_account_id is not null then 'runtime_page_fallback'
      else d.data_match_status end as data_match_status
from public.v8_report_daily_runtime_detail d
left join lateral (
 select l.ad_account_id
 from public.v8_meta_page_ad_accounts l
 where l.page_id=d.page_id
 order by l.is_primary desc,l.updated_at desc
 limit 1
) pa on true
left join public.v8_meta_ad_accounts fa on fa.ad_account_id=pa.ad_account_id;
