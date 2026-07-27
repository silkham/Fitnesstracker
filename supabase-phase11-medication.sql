-- ============================================================
-- Phase 11 — GLP-1 (oral semaglutide) medication support
-- Run once in Supabase → SQL Editor. Non-destructive:
--   • new table med_log (one row per member per day)
--   • 6 nullable columns on members (medication + intake floors)
--   • 1 nullable column on weight_entries (waist_cm)
-- No drops, no data rewrites. Safe to re-run (idempotent).
--
-- The app RECORDS what was taken. It never decides a dose — dose_mg is
-- always whatever the user entered, and nothing here encodes escalation.
-- ============================================================

-- 1) med_log — one row per (member, day). Re-logging a day upserts.
create table if not exists public.med_log (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households(id) on delete cascade,
  member_id     uuid not null references public.members(id)    on delete cascade,
  log_date      date not null default current_date,
  dose_mg       numeric(6,2),                                   -- the dose actually taken
  dose_state    text check (dose_state in ('taken','skipped','missed')),
  taken_at      timestamptz,                                    -- real clock time; drives the 30-min window
  nausea        smallint check (nausea       between 0 and 3),
  constipation  smallint check (constipation between 0 and 3),
  reflux        smallint check (reflux       between 0 and 3),
  energy        smallint check (energy       between 0 and 3),
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (member_id, log_date)
);

create index if not exists med_log_member_date_idx
  on public.med_log (member_id, log_date desc);

alter table public.med_log enable row level security;

drop policy if exists "med_log in my household - select" on public.med_log;
create policy "med_log in my household - select"
  on public.med_log for select
  using ( household_id in (
    select household_id from public.household_memberships
    where user_id = auth.uid()
  ));

drop policy if exists "med_log in my household - write" on public.med_log;
create policy "med_log in my household - write"
  on public.med_log for all
  using ( household_id in (
    select household_id from public.household_memberships
    where user_id = auth.uid()
  ))
  with check ( household_id in (
    select household_id from public.household_memberships
    where user_id = auth.uid()
  ));

-- 2) Medication profile + intake floors, per member (manual, all nullable).
--    med_name being NULL is what keeps the whole feature invisible.
alter table public.members add column if not exists med_name              text;
alter table public.members add column if not exists med_started_on        date;
alter table public.members add column if not exists med_current_dose_mg   numeric(6,2);
alter table public.members add column if not exists med_dose_started_on   date;
-- Floors: the bottom of the intake band. Under-eating on a GLP-1 costs lean
-- mass, so the app reads "below floor" as a shortfall, not as success.
alter table public.members add column if not exists kcal_floor            int;
alter table public.members add column if not exists protein_floor_g       int;

-- 3) Waist — the better fat-loss signal when body composition is shifting.
alter table public.weight_entries add column if not exists waist_cm numeric(5,1);
