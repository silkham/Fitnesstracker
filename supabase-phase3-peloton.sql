-- ============================================================
-- Phase 3 — Peloton API ingest (replaces iCal)
-- Run once in Supabase → SQL Editor.
--
-- Adds dedup/match keys + the full set of Peloton metric columns
-- (headline numbers as typed columns; structured/undesigned data in
-- jsonb so nothing is lost before we build the UI for it), plus a
-- token store so the Edge Function avoids a full login every run.
-- ============================================================

-- ---- dedup / match keys ------------------------------------
alter table public.workouts add column if not exists peloton_workout_id     text;  -- completed workout id
alter table public.workouts add column if not exists peloton_reservation_id text;  -- reservation peloton_id (planned)
alter table public.workouts add column if not exists peloton_ride_id        text;  -- ride.id (planned↔completed match key)

-- One row per (member, completed Peloton workout). NULLs stay distinct,
-- so non-Peloton rows are unaffected.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workouts_member_peloton_workout_key') then
    alter table public.workouts
      add constraint workouts_member_peloton_workout_key unique (member_id, peloton_workout_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workouts_member_peloton_reservation_key') then
    alter table public.workouts
      add constraint workouts_member_peloton_reservation_key unique (member_id, peloton_reservation_id);
  end if;
end $$;

create index if not exists workouts_member_ride_idx
  on public.workouts (member_id, peloton_ride_id);

-- ---- Peloton metric columns (headline numbers) -------------
-- existing already: calories, avg_hr, max_hr, distance_km, duration_min
alter table public.workouts add column if not exists total_output_kj   numeric(8,2);
alter table public.workouts add column if not exists avg_output_w      int;
alter table public.workouts add column if not exists max_output_w      int;
alter table public.workouts add column if not exists avg_cadence       int;
alter table public.workouts add column if not exists max_cadence       int;
alter table public.workouts add column if not exists avg_resistance    int;
alter table public.workouts add column if not exists max_resistance    int;
alter table public.workouts add column if not exists avg_speed_kph     numeric(6,2);
alter table public.workouts add column if not exists max_speed_kph     numeric(6,2);
alter table public.workouts add column if not exists effort_points     numeric(6,1);   -- Strive
alter table public.workouts add column if not exists ftp               int;
alter table public.workouts add column if not exists leaderboard_rank  int;
alter table public.workouts add column if not exists leaderboard_total int;

-- ---- structured / not-yet-designed data (lossless) ---------
alter table public.workouts add column if not exists hr_zones    jsonb;  -- [{slug,duration}, ...]
alter table public.workouts add column if not exists peloton_raw jsonb;  -- full performance_graph summaries+metrics

-- ============================================================
-- integration_tokens — persist the Peloton refresh token between runs
-- so peloton-ingest can refresh instead of doing a full password login.
-- ============================================================
create table if not exists public.integration_tokens (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid references public.households(id) on delete cascade,
  member_id     uuid references public.members(id)    on delete cascade,
  provider      text not null,                 -- 'peloton'
  access_token  text,
  refresh_token text,
  peloton_user_id text,
  expires_at    timestamptz,
  updated_at    timestamptz not null default now(),
  unique (member_id, provider)
);

alter table public.integration_tokens enable row level security;

-- Service role (Edge Function) bypasses RLS; this policy just lets the
-- owning member read their own row from the app if ever needed.
create policy "integration_tokens in my household - select"
  on public.integration_tokens for select
  using ( household_id in (select household_id from public.household_memberships where user_id = auth.uid()) );
