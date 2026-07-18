do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef(p.oid)
    into v_definition
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='v8_run_pipeline_self_test'
  limit 1;

  if v_definition is null then
    raise exception 'V8_PIPELINE_SELF_TEST_NOT_FOUND';
  end if;

  v_definition:=replace(
    v_definition,
    "rp.action_type='clarify_multiple_products'",
    "rp.action_type in ('capture_multi_product_contact','handoff_multi_product')"
  );

  execute v_definition;
end;
$migration$;
