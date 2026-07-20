-- AIGUKA V8: stop NOT_DUE_YET rows from being postponed forever.
-- Root cause: v8_evaluate_outbound_gate returns details.due_at, while the
-- authorizer/reconciler only read ready_at or pause_until. They therefore
-- used now()+5 seconds and kept moving due_at forward on every scan.

DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.v8_authorize_outbound_send(uuid,text)'::regprocedure
  ) INTO v_definition;

  IF position($needle$nullif(g.details->>'due_at','')::timestamptz$needle$ in v_definition)=0 THEN
    v_old := $old$v_due:=coalesce(nullif(g.details->>'ready_at','')::timestamptz,nullif(g.details->>'pause_until','')::timestamptz,now()+interval '5 seconds');$old$;
    v_new := $new$v_due:=coalesce(nullif(g.details->>'ready_at','')::timestamptz,nullif(g.details->>'pause_until','')::timestamptz,nullif(g.details->>'due_at','')::timestamptz,now()+interval '5 seconds');$new$;

    IF position(v_old in v_definition)=0 THEN
      RAISE EXCEPTION 'AUTHORIZE_NOT_DUE_ANCHOR_NOT_FOUND';
    END IF;

    v_definition := replace(v_definition,v_old,v_new);
    EXECUTE v_definition;
  END IF;
END;
$migration$;

DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.v8_reconcile_ready_outbound_queue(integer)'::regprocedure
  ) INTO v_definition;

  IF position($needle$nullif(v_gate.details->>'due_at','')::timestamptz$needle$ in v_definition)=0 THEN
    v_old := $old$          nullif(v_gate.details->>'ready_at','')::timestamptz,
          nullif(v_gate.details->>'pause_until','')::timestamptz,
          now()+interval '5 seconds'$old$;
    v_new := $new$          nullif(v_gate.details->>'ready_at','')::timestamptz,
          nullif(v_gate.details->>'pause_until','')::timestamptz,
          nullif(v_gate.details->>'due_at','')::timestamptz,
          now()+interval '5 seconds'$new$;

    IF position(v_old in v_definition)=0 THEN
      RAISE EXCEPTION 'RECONCILE_NOT_DUE_ANCHOR_NOT_FOUND';
    END IF;

    v_definition := replace(v_definition,v_old,v_new);
    EXECUTE v_definition;
  END IF;
END;
$migration$;

-- Repair ready rows whose due_at was already pushed forward by the loop.
-- Preserve a real future schedule and active human/automation pause; otherwise
-- release the row immediately for the production worker.
WITH affected AS (
  SELECT
    q.id,
    q.created_at,
    first_attempt.original_due_at,
    s.manual_pause_until,
    s.automation_pause_until
  FROM public.v8_outbound_queue q
  LEFT JOIN public.v8_conversation_states s
    ON s.customer_id=q.customer_id
  LEFT JOIN LATERAL (
    SELECT nullif(a.details->>'due_at','')::timestamptz AS original_due_at
    FROM public.v8_outbound_delivery_attempts a
    WHERE a.outbound_id=q.id
      AND nullif(a.details->>'due_at','') IS NOT NULL
    ORDER BY a.created_at ASC
    LIMIT 1
  ) first_attempt ON true
  WHERE q.status='ready'
    AND q.last_error='NOT_DUE_YET'
)
UPDATE public.v8_outbound_queue q
SET due_at=greatest(
      coalesce(a.original_due_at,a.created_at),
      coalesce(a.manual_pause_until,'epoch'::timestamptz),
      coalesce(a.automation_pause_until,'epoch'::timestamptz),
      now()
    ),
    last_error=null,
    updated_at=now()
FROM affected a
WHERE q.id=a.id;
