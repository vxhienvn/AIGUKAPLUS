alter table public.v8_ai_decisions
  add column if not exists model_output jsonb,
  add column if not exists rule_advisories jsonb not null default '[]'::jsonb,
  add column if not exists decision_authority text not null default 'ai_runtime';

create or replace function public.v8_ai_authoritative_payload(p public.v8_ai_decisions)
returns jsonb
language sql
stable
set search_path to 'public'
as $$
  select jsonb_build_object(
    'customer_goal',p.customer_goal,
    'intent_type',p.intent_type,
    'product_scope',p.product_scope,
    'catalog_key',p.catalog_key,
    'confidence',p.confidence,
    'should_reply',p.should_reply,
    'final_reply',p.final_reply,
    'should_send_slide',p.should_send_slide,
    'slide_asset_ids',coalesce(p.slide_asset_ids,'[]'::jsonb),
    'should_request_contact',p.should_request_contact,
    'should_handoff_sale',p.should_handoff_sale,
    'needs_clarification',p.needs_clarification,
    'decision',coalesce(p.decision,'{}'::jsonb),
    'evidence_summary',coalesce(p.evidence_summary,'[]'::jsonb),
    'risk_flags',coalesce(p.risk_flags,'[]'::jsonb)
  );
$$;

create or replace function public.v8_capture_ai_authoritative_output()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status='completed' then
    if tg_op='INSERT' then
      if new.model_output is null then new.model_output:=public.v8_ai_authoritative_payload(new); end if;
      new.decision_authority:=coalesce(nullif(new.decision_authority,''),'ai_runtime');
    elsif old.status is distinct from 'completed' or new.model_output is null then
      new.model_output:=public.v8_ai_authoritative_payload(new);
      new.decision_authority:='ai_runtime';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.v8_assert_ai_authoritative_output_unchanged()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status='completed' and new.model_output is not null
     and public.v8_ai_authoritative_payload(new) is distinct from new.model_output then
    raise exception 'AI_DECISION_AUTHORITY_VIOLATION';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_v8_00_capture_ai_authority on public.v8_ai_decisions;
create trigger trg_v8_00_capture_ai_authority
before insert or update of status,customer_goal,intent_type,product_scope,catalog_key,confidence,should_reply,final_reply,should_send_slide,slide_asset_ids,should_request_contact,should_handoff_sale,needs_clarification,decision,evidence_summary,risk_flags
on public.v8_ai_decisions
for each row execute function public.v8_capture_ai_authoritative_output();

drop trigger if exists trg_v8_zzz_assert_ai_authority on public.v8_ai_decisions;
create trigger trg_v8_zzz_assert_ai_authority
before insert or update on public.v8_ai_decisions
for each row execute function public.v8_assert_ai_authoritative_output_unchanged();