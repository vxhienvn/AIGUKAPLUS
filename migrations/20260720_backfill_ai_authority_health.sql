update public.v8_ai_decisions d
set model_output=public.v8_ai_authoritative_payload(d),
    decision_authority='legacy_snapshot'
where d.status='completed' and d.model_output is null;

create or replace view public.v8_ai_authority_health as
select
  count(*) filter(where status='completed')::bigint as completed_decisions,
  count(*) filter(where status='completed' and model_output is null)::bigint as missing_authoritative_snapshot,
  count(*) filter(
    where status='completed'
      and model_output is not null
      and public.v8_ai_authoritative_payload(v8_ai_decisions) is distinct from model_output
  )::bigint as authority_drift,
  count(*) filter(
    where status='completed'
      and exists(
        select 1
        from jsonb_array_elements(coalesce(rule_advisories,'[]'::jsonb)) e(value)
        where e.value->>'severity'='block'
      )
  )::bigint as blocked_by_advisory,
  max(updated_at) as latest_decision_at
from public.v8_ai_decisions;