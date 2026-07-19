-- Link a customer's Messenger response to the originating Page comment/private reply.

create or replace function public.v8_link_comment_private_reply_response()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_echo boolean:=coalesce((new.raw_payload->'message'->>'is_echo')::boolean,false);
  v_customer_id uuid;
  v_comment_id text;
  v_post_id text;
  v_linked_id uuid;
begin
  if v_is_echo or nullif(new.sender_id,'') is null or nullif(new.page_id,'') is null then return new; end if;

  select c.id into v_customer_id
  from public.v8_customers c
  where c.page_id=new.page_id and c.sender_id=new.sender_id
  limit 1;

  v_comment_id:=coalesce(
    nullif(new.referral->>'comment_id',''),
    nullif(new.referral->'ads_context_data'->>'comment_id',''),
    nullif(new.raw_payload->'message'->'referral'->>'comment_id',''),
    nullif(new.raw_payload->'referral'->>'comment_id','')
  );
  v_post_id:=coalesce(
    nullif(new.referral->>'post_id',''),
    nullif(new.referral->'ads_context_data'->>'post_id',''),
    nullif(new.raw_payload->'message'->'referral'->'ads_context_data'->>'post_id',''),
    nullif(new.raw_payload->'referral'->'ads_context_data'->>'post_id','')
  );

  select ce.id into v_linked_id
  from public.v8_comment_events ce
  where ce.page_id=new.page_id
    and ce.private_reply_status in ('sent','responded')
    and ce.private_reply_sent_at>=coalesce(new.event_time,now())-interval '7 days'
    and ce.private_reply_sent_at<=coalesce(new.event_time,now())
    and (
      (v_comment_id is not null and ce.comment_id=v_comment_id)
      or (ce.sender_id=new.sender_id and (v_post_id is null or ce.post_id=v_post_id))
    )
  order by
    case when v_comment_id is not null and ce.comment_id=v_comment_id then 0 else 1 end,
    ce.private_reply_sent_at desc
  limit 1;

  if v_linked_id is null then return new; end if;

  update public.v8_comment_events
  set customer_id=coalesce(v_customer_id,customer_id),
      private_reply_status='responded',
      lead_status=case when lead_status='qualified' then 'messenger_engaged' else lead_status end,
      classifier_reason=coalesce(classifier_reason,'{}'::jsonb)||jsonb_build_object(
        'messenger_response_linked',true,
        'messenger_message_id',new.message_id,
        'messenger_response_at',coalesce(new.event_time,now()),
        'link_method',case
          when v_comment_id is not null then 'comment_id'
          when v_post_id is not null then 'sender_and_post'
          else 'sender_id'
        end
      ),
      updated_at=now()
  where id=v_linked_id;

  if v_customer_id is not null then
    update public.v8_customers
    set raw_profile=coalesce(raw_profile,'{}'::jsonb)||jsonb_build_object(
          'comment_origin',true,
          'comment_event_id',v_linked_id,
          'comment_response_message_id',new.message_id
        ),
        last_seen_at=greatest(coalesce(last_seen_at,'epoch'::timestamptz),coalesce(new.event_time,now()))
    where id=v_customer_id;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_v8_link_comment_private_reply_response on public.v8_meta_events;
create trigger trg_v8_link_comment_private_reply_response
after insert or update of sender_id,referral,raw_payload,message_text
on public.v8_meta_events
for each row execute function public.v8_link_comment_private_reply_response();

create or replace view public.v8_comment_messenger_overview as
select
  ce.page_id,
  p.page_name,
  count(*) as comment_events,
  count(*) filter(where ce.lead_status in ('qualified','messenger_engaged')) as qualified_comments,
  count(*) filter(where ce.lead_status='contact_provided') as comments_with_contact,
  count(*) filter(where ce.lead_status='manual_review') as manual_review_comments,
  count(*) filter(where ce.private_reply_status='queued') as private_reply_queued,
  count(*) filter(where ce.private_reply_status='sending') as private_reply_sending,
  count(*) filter(where ce.private_reply_status='sent') as private_reply_sent,
  count(*) filter(where ce.private_reply_status='responded') as messenger_responses,
  count(*) filter(where ce.private_reply_status in ('failed','cancelled','stage_error')) as private_reply_errors,
  max(ce.event_time) as latest_comment_at
from public.v8_comment_events ce
left join public.v8_pages p on p.page_id=ce.page_id
group by ce.page_id,p.page_name;
