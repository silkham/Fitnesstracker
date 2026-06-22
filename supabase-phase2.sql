-- ============================================================
-- Phase 2 — Apple Health sync (workouts)
-- Run once in Supabase → SQL Editor.
-- Adds a stable key so the Shortcut can upsert Health workouts
-- without ever creating duplicates on re-runs.
-- ============================================================

alter table public.workouts add column if not exists health_uid text;
alter table public.workouts add column if not exists source text;

-- One row per (member, health workout). NULLs stay distinct, so existing
-- app-created workouts (health_uid = null) are unaffected.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'workouts_member_health_uid_key'
  ) then
    alter table public.workouts
      add constraint workouts_member_health_uid_key unique (member_id, health_uid);
  end if;
end $$;

-- ============================================================
-- Helper: run this SELECT once and note YOUR row's values —
-- you'll paste member_id + household_id into the Shortcut.
-- ============================================================
-- select display_name, id as member_id, household_id from public.members order by display_name;
