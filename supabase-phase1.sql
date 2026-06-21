-- ============================================================
-- Phase 1 — Strength logging
-- Run this once in Supabase → SQL Editor.
-- Weight (weight_entries) and workout consistency (workouts) already exist.
-- This adds per-set strength tracking: exercise, sets, reps, weight.
-- ============================================================

create table if not exists public.strength_sets (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households(id) on delete cascade,
  member_id     uuid not null references public.members(id)   on delete cascade,
  performed_at  date not null default current_date,
  exercise      text not null,            -- e.g. "Bench press"
  set_number    int  not null default 1,  -- 1, 2, 3 ...
  reps          int,
  weight_kg     numeric(6,2),
  notes         text,
  created_at    timestamptz not null default now()
);

create index if not exists strength_sets_member_date_idx
  on public.strength_sets (member_id, performed_at desc);

create index if not exists strength_sets_exercise_idx
  on public.strength_sets (member_id, exercise, performed_at desc);

-- Row Level Security: a member can only see/write rows in their own household.
alter table public.strength_sets enable row level security;

create policy "strength_sets in my household - select"
  on public.strength_sets for select
  using ( household_id in (
    select household_id from public.household_memberships
    where user_id = auth.uid()
  ));

create policy "strength_sets in my household - write"
  on public.strength_sets for all
  using ( household_id in (
    select household_id from public.household_memberships
    where user_id = auth.uid()
  ))
  with check ( household_id in (
    select household_id from public.household_memberships
    where user_id = auth.uid()
  ));
