do $$
declare r record;
begin
  for r in select jobid from cron.job where jobname='aiguka-catalog-storage-sync' loop
    perform cron.unschedule(r.jobid);
  end loop;
end $$;

select cron.schedule(
  'aiguka-catalog-storage-sync',
  '*/10 * * * *',
  $job$
  select net.http_post(
    url := 'https://ezygfpeeqbbirdeazene.supabase.co/functions/v1/aiguka-drive-storage-sync',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{"batch":40,"concurrency":5}'::jsonb
  );
  $job$
);
