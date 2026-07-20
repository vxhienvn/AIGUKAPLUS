-- AIGUKA V8: Meta Conversations API does not expose is_automatic for many
-- page replies. Recognize the known text-based automatic greeting and the
-- comment-reply system notice so they do not create a false 10-minute human pause.

create or replace function public.v8_is_meta_system_notice(p_message_text text)
returns boolean
language sql
stable
set search_path to 'public'
as $function$
  with n as (
    select public.v8_normalize_detector_text(coalesce(p_message_text,'')) as txt
  )
  select
    txt ~ '(^| )(da tra loi mot quang cao|da phan hoi mot quang cao|replied to an ad|started a conversation from an ad)( |[.]|$)'
    or txt ~ '(^| )ban dang phan hoi binh luan cua nguoi dung ve bai viet tren trang cua minh( |[.]|$)'
    or txt ~ '(^| )you are replying to a user.?s comment on your page post( |[.]|$)'
  from n;
$function$;

create or replace function public.v8_is_meta_generic_contact_template(
  p_message_text text,
  p_attachments jsonb default '[]'::jsonb,
  p_source_detail jsonb default '{}'::jsonb
)
returns boolean
language sql
stable
set search_path to 'public'
as $function$
  with n as (
    select public.v8_normalize_detector_text(coalesce(p_message_text,'')) as txt
  )
  select
    (
      nullif(btrim(coalesce(p_message_text,'')),'') is null
      and public.v8_jsonb_has_attachments(p_attachments)
      and lower(coalesce(p_attachments::text,'')) like '%generic_template%'
      and (
        lower(coalesce(p_attachments::text,'')) like '%zalo.me%'
        or public.v8_normalize_detector_text(coalesce(p_attachments::text,'')) ~ '(hotline|tu van va bao gia|so dien thoai)'
      )
    )
    or (
      txt ~ '(anh|chi|ban).*dang quan tam.*mau san pham nao'
      and txt ~ '(gui|de lai).*so dien thoai'
      and txt ~ '(tu van|bao gia)'
    )
  from n;
$function$;

-- Reclassify recent history rows. Existing triggers update actor/source metadata
-- and conversation automation state.
update public.v8_messages_raw
set direction='system',
    actor_type='meta_system',
    actor_name='Meta system',
    source_system='meta_system_notice',
    is_automatic=true,
    actor_confidence='system_notice',
    source_detail=coalesce(source_detail,'{}'::jsonb)||jsonb_build_object(
      'classification','meta_system_notice',
      'reclassified_at',now()
    )
where sent_at>=now()-interval '14 days'
  and public.v8_is_meta_system_notice(message_text)
  and direction<>'system';

update public.v8_messages_raw
set actor_type='page_automation',
    actor_name=coalesce(nullif(actor_name,''),'Meta/Page automation'),
    source_system='meta_page_automation',
    is_automatic=true,
    actor_confidence='automation_text_template',
    source_detail=coalesce(source_detail,'{}'::jsonb)||jsonb_build_object(
      'classification','meta_generic_contact_text_template',
      'reclassified_at',now()
    )
where sent_at>=now()-interval '14 days'
  and direction='outbound'
  and coalesce(source_system,'') in ('meta_page_history','meta_page_automation')
  and public.v8_is_meta_generic_contact_template(message_text,attachments,source_detail);

-- Remove a false human pause only when the row currently referenced as the
-- latest human message has just been reclassified as automation/system.
update public.v8_conversation_states s
set last_human_message_at=null,
    manual_pause_until=null,
    updated_at=now(),
    metadata=coalesce(s.metadata,'{}'::jsonb)||jsonb_build_object(
      'false_human_pause_cleared',true,
      'false_human_pause_cleared_at',now()
    )
where s.last_human_message_at is not null
  and exists (
    select 1
    from public.v8_messages_raw m
    where m.customer_id=s.customer_id
      and m.sent_at=s.last_human_message_at
      and (
        m.direction<>'outbound'
        or coalesce(m.is_automatic,false)=true
        or m.source_system in ('meta_system_notice','meta_page_automation')
      )
  );
