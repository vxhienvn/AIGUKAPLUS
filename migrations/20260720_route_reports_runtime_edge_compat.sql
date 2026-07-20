-- Route all report consumers to the corrected runtime source without changing the public contract.
create or replace view public.v8_report_ad_performance_daily as
select
  tenant_id,report_date,page_id,page_name,ad_account_id,ad_account_name,
  campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,effective_status,
  currency,account_timezone,spend,tax_amount,spend_with_tax,impressions,reach,
  clicks,link_clicks,meta_conversations,conversations,contacts,hot_leads,
  message_count,meta_leads,contact_rate,cost_per_conversation,cost_per_contact,
  payment_method_last4,data_match_status
from public.v8_report_daily_runtime_detail;

-- The deployed report UI requests this compatibility field while loading filters.
create or replace view public.v8_meta_ad_account_registry as
select
  t.id as tenant_id,t.tenant_key,t.tenant_name,
  a.id as meta_app_id,a.app_key,a.app_id,a.app_name,
  x.id as ad_account_record_id,x.ad_account_id,x.ad_account_name,x.business_id,
  x.currency,x.timezone_name,x.account_status,x.permissions,x.reporting_enabled,
  x.management_enabled,x.is_active,x.meta_connection_id,
  c.connection_name,c.connection_type,c.status as oauth_status,
  x.source,x.last_synced_at,x.last_verified_at,x.last_error,x.created_at,x.updated_at,
  x.payment_method_last4
from public.v8_meta_ad_accounts x
join public.v8_tenants t on t.id=x.tenant_id
join public.v8_meta_apps a on a.id=x.meta_app_id
left join public.v8_meta_connections c on c.id=x.meta_connection_id;

-- Compatibility for the deployed system-status query.
alter table public.v8_worker_runs add column if not exists error_message text;
update public.v8_worker_runs set error_message=error where error_message is null and error is not null;

create or replace function public.v8_sync_worker_error_message()
returns trigger language plpgsql set search_path='public' as $function$
begin
  new.error_message:=new.error;
  return new;
end;$function$;

drop trigger if exists trg_v8_sync_worker_error_message on public.v8_worker_runs;
create trigger trg_v8_sync_worker_error_message
before insert or update of error on public.v8_worker_runs
for each row execute function public.v8_sync_worker_error_message();

grant select on public.v8_report_ad_performance_daily to anon,authenticated,service_role;
grant select on public.v8_meta_ad_account_registry to anon,authenticated,service_role;
