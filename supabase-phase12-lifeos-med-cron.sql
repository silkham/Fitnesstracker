-- ============================================================
-- Phase 12 — hourly server-side refresh of the LifeOS `med` signal
--
-- Every other Stride signal publishes client-side, on app-open. That's right
-- for things that only change when you act in the app — but a once-daily
-- medication's DAY ROLLS OVER while the app is closed, so the hub showed no
-- prompt at all until Stride was next opened. Same fix the Investing app uses
-- for its portfolio tile: pg_cron → Edge Function.
--
-- TWO PREREQUISITES, both already done except the grant:
--   1. The function is DEPLOYED (done 2026-07-27). Note the flag — the gateway
--      rejects a non-JWT bearer before the function runs, and this function does
--      its own auth (INGEST_SECRET or a user JWT), exactly like peloton-ingest:
--        supabase functions deploy lifeos-med-refresh \
--          --project-ref dgbbyijhabjozqrkokrq --no-verify-jwt
--   2. service_role can reach the lifeos schema. The LifeOS init migration
--      granted only authenticated/anon, so the first SERVER-side publisher gets
--      `42501 permission denied for schema lifeos`. Run this FIRST:
--        LifeOS/supabase/migrations/20260727200000_service_role_grants.sql
--
-- NON-DESTRUCTIVE apart from replacing a job of the same name. Re-runnable.
--
-- NOTE ON THE SECRET: the bearer is read out of the EXISTING peloton-ingest-4h
-- job rather than written here, so INGEST_SECRET never lands in git.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_secret text;
  v_cmd    text;
  v_url    text := 'https://dgbbyijhabjozqrkokrq.supabase.co/functions/v1/lifeos-med-refresh';
begin
  select (regexp_match(command, 'Bearer ([^"]+)'))[1]
    into v_secret
    from cron.job
   where jobname = 'peloton-ingest-4h';

  if v_secret is null then
    raise exception
      'Could not read INGEST_SECRET from the peloton-ingest-4h cron job. Schedule this one by hand with the same bearer.';
  end if;

  if exists (select 1 from cron.job where jobname = 'lifeos-med-refresh-hourly') then
    perform cron.unschedule('lifeos-med-refresh-hourly');
  end if;

  v_cmd := format(
    $f$select net.http_post(url := %L, headers := %L::jsonb, body := '{}'::jsonb) as request_id;$f$,
    v_url,
    format('{"Content-Type":"application/json","Authorization":"Bearer %s"}', v_secret)
  );

  -- Hourly, not once a day: DST-proof (no local-vs-UTC drift to get wrong),
  -- self-healing if one run fails, and it keeps the row honest all day.
  perform cron.schedule('lifeos-med-refresh-hourly', '0 * * * *', v_cmd);
end $$;

-- Confirm it landed (the bearer is masked in this readback).
select jobid, jobname, schedule, active,
       regexp_replace(command, 'Bearer [^"]+', 'Bearer ***') as command
  from cron.job
 where jobname = 'lifeos-med-refresh-hourly';
