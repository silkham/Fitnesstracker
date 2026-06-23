-- ============================================================
-- 3.1 — daily health metrics (for the readiness score)
-- Run once in Supabase → SQL Editor.
-- ============================================================

create table if not exists public.health_metrics (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references public.households(id) on delete cascade,
  member_id         uuid not null references public.members(id)   on delete cascade,
  metric_date       date not null,
  hrv               numeric,   -- heart rate variability (ms)
  resting_hr        int,       -- resting heart rate (bpm)
  vo2max            numeric,   -- VO2 max
  respiratory_rate  numeric,
  created_at        timestamptz not null default now(),
  unique (member_id, metric_date)
);

alter table public.health_metrics enable row level security;

create policy "health_metrics in my household - select"
  on public.health_metrics for select
  using ( household_id in (select household_id from public.household_memberships where user_id = auth.uid()) );

create policy "health_metrics in my household - write"
  on public.health_metrics for all
  using ( household_id in (select household_id from public.household_memberships where user_id = auth.uid()) )
  with check ( household_id in (select household_id from public.household_memberships where user_id = auth.uid()) );
