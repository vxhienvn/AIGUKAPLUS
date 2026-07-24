-- Applied manually to production Supabase on 2026-07-24.
-- Stored here for audit; do not auto-replay during Railway startup.
-- Keep the four-second outbound claim path lightweight.
create or replace function public.v8_claim_outbound_batch(
  p_worker_name text default 'v8-outbound-worker',
  p_batch_size integer default 10
)
returns setof public.v8_outbound_queue
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.v8_release_stale_outbound(2);

  return query
  with due_rows as (
    select q.id
    from public.v8_outbound_queue q
    where q.status='ready'
      and q.due_at<=now()
      and q.attempts<q.max_attempts
    order by q.due_at,q.created_at
    for update of q skip locked
    limit least(greatest(coalesce(p_batch_size,10)*3,3),50)
  ), candidates as (
    select d.id
    from due_rows d
    cross join lateral public.v8_evaluate_outbound_gate(d.id) gate
    where gate.allowed
    limit least(greatest(coalesce(p_batch_size,10),1),50)
  )
  update public.v8_outbound_queue q
  set status='sending',
      attempts=q.attempts+1,
      locked_at=now(),
      locked_by=p_worker_name,
      authorized_at=null,
      authorized_by=null,
      authorization_version=null,
      authorization_details='{}'::jsonb,
      last_error=null,
      updated_at=now()
  from candidates c
  where q.id=c.id
  returning q.*;
end;
$function$;
