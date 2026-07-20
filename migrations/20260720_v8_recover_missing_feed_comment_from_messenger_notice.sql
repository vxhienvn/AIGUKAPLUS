-- AIGUKA V8: recover comment origin when Meta does not deliver the feed webhook.
-- A Messenger history notice such as
-- "Bạn đang phản hồi bình luận...comment_id=..." proves that the conversation
-- originated from a Page comment. Store a non-sendable recovered comment event
-- so the lead timeline and attribution do not start incorrectly at Messenger.

create or replace function public.v8_recover_comment_from_meta_notice()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_comment_id text;
  v_post_id text;
  v_sender_name text;
begin
  if new.page_id is null
     or new.sender_id is null
     or nullif(btrim(coalesce(new.message_text,'')),'') is null then
    return new;
  end if;

  if coalesce(new.source_system,'') <> 'meta_system_notice'
     and not public.v8_is_meta_system_notice(new.message_text) then
    return new;
  end if;

  v_comment_id := substring(new.message_text from 'comment_id=([0-9]+)');
  if v_comment_id is null then
    return new;
  end if;

  v_post_id := substring(new.message_text from 'story_fbid=([^& )]+)');

  select c.display_name into v_sender_name
  from public.v8_customers c
  where c.id=new.customer_id;

  insert into public.v8_comment_events(
    page_id,comment_id,parent_id,post_id,sender_id,sender_name,message_text,
    event_time,verb,item_type,lead_score,lead_status,classifier_reason,
    has_contact,detected_phone,private_reply_status,customer_id,raw_payload,updated_at
  ) values(
    new.page_id,v_comment_id,null,v_post_id,new.sender_id,v_sender_name,null,
    coalesce(new.sent_at,now()),'add','comment',40,'qualified',
    jsonb_build_object(
      'reason','recovered_from_meta_comment_notice',
      'feed_webhook_missing',true,
      'notice_message_id',new.message_id,
      'notice_sent_at',new.sent_at
    ),
    false,null,'conversation_opened',new.customer_id,
    jsonb_build_object(
      'source','meta_comment_notice_recovery',
      'notice_message_id',new.message_id,
      'notice_text',new.message_text,
      'source_detail',coalesce(new.source_detail,'{}'::jsonb),
      'raw_notice',coalesce(new.raw_payload,'{}'::jsonb)
    ),
    now()
  )
  on conflict(page_id,comment_id) do update set
    post_id=coalesce(public.v8_comment_events.post_id,excluded.post_id),
    sender_id=coalesce(public.v8_comment_events.sender_id,excluded.sender_id),
    sender_name=coalesce(public.v8_comment_events.sender_name,excluded.sender_name),
    customer_id=coalesce(public.v8_comment_events.customer_id,excluded.customer_id),
    event_time=least(public.v8_comment_events.event_time,excluded.event_time),
    classifier_reason=coalesce(public.v8_comment_events.classifier_reason,'{}'::jsonb)
      || excluded.classifier_reason,
    private_reply_status=case
      when public.v8_comment_events.private_reply_status in ('sent','queued','sending')
        then public.v8_comment_events.private_reply_status
      else 'conversation_opened'
    end,
    raw_payload=coalesce(public.v8_comment_events.raw_payload,'{}'::jsonb)
      || excluded.raw_payload,
    updated_at=now();

  return new;
end;
$function$;

drop trigger if exists trg_v8_recover_comment_from_meta_notice on public.v8_messages_raw;
create trigger trg_v8_recover_comment_from_meta_notice
after insert or update of direction,source_system,message_text,sender_id,customer_id,sent_at
on public.v8_messages_raw
for each row
execute function public.v8_recover_comment_from_meta_notice();

-- Backfill notices already captured before this repair.
insert into public.v8_comment_events(
  page_id,comment_id,parent_id,post_id,sender_id,sender_name,message_text,
  event_time,verb,item_type,lead_score,lead_status,classifier_reason,
  has_contact,detected_phone,private_reply_status,customer_id,raw_payload,updated_at
)
select
  m.page_id,
  substring(m.message_text from 'comment_id=([0-9]+)'),
  null,
  substring(m.message_text from 'story_fbid=([^& )]+)'),
  m.sender_id,
  c.display_name,
  null,
  m.sent_at,
  'add','comment',40,'qualified',
  jsonb_build_object(
    'reason','recovered_from_meta_comment_notice',
    'feed_webhook_missing',true,
    'notice_message_id',m.message_id,
    'notice_sent_at',m.sent_at,
    'backfilled',true
  ),
  false,null,'conversation_opened',m.customer_id,
  jsonb_build_object(
    'source','meta_comment_notice_recovery',
    'notice_message_id',m.message_id,
    'notice_text',m.message_text,
    'source_detail',coalesce(m.source_detail,'{}'::jsonb),
    'raw_notice',coalesce(m.raw_payload,'{}'::jsonb),
    'backfilled',true
  ),
  now()
from public.v8_messages_raw m
left join public.v8_customers c on c.id=m.customer_id
where m.page_id is not null
  and m.sender_id is not null
  and substring(m.message_text from 'comment_id=([0-9]+)') is not null
  and (
    coalesce(m.source_system,'')='meta_system_notice'
    or public.v8_is_meta_system_notice(m.message_text)
  )
on conflict(page_id,comment_id) do update set
  post_id=coalesce(public.v8_comment_events.post_id,excluded.post_id),
  sender_id=coalesce(public.v8_comment_events.sender_id,excluded.sender_id),
  sender_name=coalesce(public.v8_comment_events.sender_name,excluded.sender_name),
  customer_id=coalesce(public.v8_comment_events.customer_id,excluded.customer_id),
  event_time=least(public.v8_comment_events.event_time,excluded.event_time),
  classifier_reason=coalesce(public.v8_comment_events.classifier_reason,'{}'::jsonb)
    || excluded.classifier_reason,
  private_reply_status=case
    when public.v8_comment_events.private_reply_status in ('sent','queued','sending')
      then public.v8_comment_events.private_reply_status
    else 'conversation_opened'
  end,
  raw_payload=coalesce(public.v8_comment_events.raw_payload,'{}'::jsonb)
    || excluded.raw_payload,
  updated_at=now();