-- Fail deployment if a later merge restores the single-catalog-only regression
-- or removes the image/text delivery dependency and 24h follow-up policy.

do $$
declare
  v_stage text:=pg_get_functiondef('public.v8_ai_stage_decision(uuid)'::regprocedure);
  v_carousel_guard text:=pg_get_functiondef('public.v8_guard_single_catalog_carousel()'::regprocedure);
  v_followup jsonb;
begin
  if position('v8_ai_stage_multi_catalog_decision' in v_stage)=0
     or position('v8_ai_stage_decision_single_catalog' in v_stage)=0 then
    raise exception 'UNIFIED_V2_STAGE_ROUTER_MISSING';
  end if;

  if position('multi_catalog_balanced' in v_carousel_guard)=0
     or position('allowed_multi_mode' in v_carousel_guard)=0 then
    raise exception 'BALANCED_MULTI_CATALOG_GUARD_MISSING';
  end if;

  if not exists(select 1 from pg_trigger where tgrelid='public.v8_outbound_queue'::regclass and tgname='trg_v8_00_gate_ai_text_until_slide_sent' and tgenabled<>'D') then
    raise exception 'SLIDE_TEXT_DEPENDENCY_TRIGGER_MISSING';
  end if;
  if not exists(select 1 from pg_trigger where tgrelid='public.v8_outbound_queue'::regclass and tgname='trg_v8_release_ai_text_after_slide_sent' and tgenabled<>'D') then
    raise exception 'SLIDE_TEXT_RELEASE_TRIGGER_MISSING';
  end if;
  if not exists(select 1 from pg_trigger where tgrelid='public.v8_outbound_queue'::regclass and tgname='a0_trg_v8_reanchor_carousel_to_sendable_slide' and tgenabled<>'D') then
    raise exception 'CAROUSEL_SENDABLE_ANCHOR_TRIGGER_MISSING';
  end if;

  select value into v_followup from public.v8_config_hub
  where key='follow_up_policy' and scope='conversation' and is_active
  order by updated_at desc limit 1;
  if coalesce((v_followup->>'quiet_hours_enabled')::boolean,true) then
    raise exception 'FOLLOW_UP_24H_POLICY_NOT_ACTIVE';
  end if;
  if coalesce((v_followup->>'scan_interval_minutes')::integer,10)>2 then
    raise exception 'FOLLOW_UP_SCAN_INTERVAL_TOO_SLOW';
  end if;

  if to_regprocedure('public.v8_regression_test_multi_catalog_delivery_dependency()') is null then
    raise exception 'MULTI_CATALOG_DELIVERY_REGRESSION_TEST_MISSING';
  end if;
end
$$;
