-- Recover the real Page post/Reel ID from Meta Messenger comment notices.
-- This is required before an old or paused ad creative can be matched safely.

create or replace function public.v8_extract_meta_post_id(p_text text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select coalesce(
    substring(coalesce(p_text,'') from 'story_fbid=([0-9]+)'),
    substring(coalesce(p_text,'') from '/reel/([0-9]+)'),
    substring(coalesce(p_text,'') from '/posts/([0-9]+)'),
    substring(coalesce(p_text,'') from '/videos/([0-9]+)')
  );
$function$;

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

  v_post_id := public.v8_extract_meta_post_id(new.message_text);

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

-- Backfill notices that were recovered before Reel URLs were supported.
update public.v8_comment_events c
set post_id = public.v8_extract_meta_post_id(
      coalesce(
        c.raw_payload->>'notice_text',
        c.raw_payload#>>'{raw_notice,message}',
        ''
      )
    ),
    updated_at = now()
where c.post_id is null
  and coalesce(c.raw_payload->>'source','')='meta_comment_notice_recovery'
  and public.v8_extract_meta_post_id(
        coalesce(
          c.raw_payload->>'notice_text',
          c.raw_payload#>>'{raw_notice,message}',
          ''
        )
      ) is not null;
