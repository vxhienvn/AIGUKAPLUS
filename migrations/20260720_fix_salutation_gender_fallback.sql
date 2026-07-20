create or replace function public.v8_infer_gender_from_vietnamese_name(p_name text)
returns table(gender text, salutation text, confidence numeric)
language plpgsql
immutable
set search_path to 'public'
as $$
declare
  v_name text:=lower(btrim(coalesce(p_name,'')));
  v_last text;
begin
  if v_name='' or v_name ~ '^(khách|customer)(\s|$)' then return; end if;
  v_last:=regexp_replace(v_name,'^.*\s','','g');
  if v_last in ('tuấn','hùng','dũng','cường','hiếu','huy','long','nam','sơn','tùng','quang','thành','thắng','tiến','đức','phúc','khoa','kiên','vũ','toàn','trung','trường','thịnh','đạt','bình','hải','lâm','luân','mạnh','nghĩa','phong','tài','thái','vinh') then
    return query select 'male'::text,'anh'::text,0.98::numeric;
  elsif v_last in ('hương','lan','thúy','nguyệt','trang','hoa','hạnh','nga','mai','loan','yến','nhung','thu','thảo','oanh','huyền','diệp','dung','giang','hiền','hoài','lệ','liên','ly','my','nhi','quyên','quỳnh','tâm','thư','trâm','trinh','tuyết','vy') then
    return query select 'female'::text,'chị'::text,0.98::numeric;
  end if;
end;
$$;

create or replace function public.v8_apply_customer_name_gender_fallback()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_gender text;
  v_sal text;
  v_conf numeric;
begin
  if new.gender_source in ('manual','meta_profile') then return new; end if;
  if nullif(btrim(coalesce(new.display_name,'')),'') is null then return new; end if;
  select x.gender,x.salutation,x.confidence into v_gender,v_sal,v_conf
  from public.v8_infer_gender_from_vietnamese_name(new.display_name) x limit 1;
  if v_gender is not null and v_conf>=0.95 then
    new.gender:=v_gender;
    new.gender_source:='name_inference_high_confidence';
    new.gender_synced_at:=now();
  elsif new.gender_source='name_inference_high_confidence' then
    new.gender:=null;
    new.gender_source:=null;
    new.gender_synced_at:=null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_v8_customer_name_gender_fallback on public.v8_customers;
create trigger trg_v8_customer_name_gender_fallback
before insert or update of display_name,first_name,last_name on public.v8_customers
for each row execute function public.v8_apply_customer_name_gender_fallback();

with latest_name as (
  select distinct on (m.customer_id) m.customer_id,m.actor_name
  from public.v8_messages_raw m
  where m.customer_id is not null
    and m.direction='inbound'
    and coalesce(m.actor_type,'customer')='customer'
    and nullif(btrim(coalesce(m.actor_name,'')),'') is not null
    and lower(m.actor_name) not like 'khách %'
  order by m.customer_id,coalesce(m.sent_at,m.created_at) desc
)
update public.v8_customers c
set display_name=n.actor_name,
    first_name=case when position(' ' in n.actor_name)>0 then split_part(n.actor_name,' ',array_length(regexp_split_to_array(n.actor_name,'\s+'),1)) else n.actor_name end,
    profile_sync_status=case when c.profile_sync_status in ('deferred_on_demand','pending',null) then 'partial_from_conversation' else c.profile_sync_status end,
    raw_profile=coalesce(c.raw_profile,'{}'::jsonb)||jsonb_build_object('name_source','meta_conversation_actor')
from latest_name n
where c.id=n.customer_id
  and (c.display_name is null or c.display_name like 'Khách %' or c.raw_profile->>'profile_source'='webhook_placeholder');