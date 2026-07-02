-- ============================================================
-- Phase 10 — Photo-based meal logging
-- Run once in Supabase → SQL Editor. Non-destructive:
--   • new table meal_logs (per-member daily meal entries + macros)
--   • 4 nullable macro-target columns on members
--   • public 'meal-photos' storage bucket (client uploads, RLS-guarded write)
-- The old week_plans meal planner is left intact; the app just stops showing it.
-- ============================================================

-- 1) meal_logs — one row per (member, day, slot). Re-logging a slot upserts.
create table if not exists public.meal_logs (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households(id) on delete cascade,
  member_id     uuid not null references public.members(id)    on delete cascade,
  log_date      date not null default current_date,
  slot          text not null check (slot in ('breakfast','lunch','dinner','snack')),
  state         text not null default 'logged' check (state in ('logged','skipped')),
  name          text,
  kcal          int,
  protein_g     numeric(6,1),
  carbs_g       numeric(6,1),
  fat_g         numeric(6,1),
  note          text,
  photo_url     text,
  items         jsonb,          -- optional AI item breakdown
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (member_id, log_date, slot)
);

create index if not exists meal_logs_member_date_idx
  on public.meal_logs (member_id, log_date desc);

alter table public.meal_logs enable row level security;

drop policy if exists "meal_logs in my household - select" on public.meal_logs;
create policy "meal_logs in my household - select"
  on public.meal_logs for select
  using ( household_id in (
    select household_id from public.household_memberships
    where user_id = auth.uid()
  ));

drop policy if exists "meal_logs in my household - write" on public.meal_logs;
create policy "meal_logs in my household - write"
  on public.meal_logs for all
  using ( household_id in (
    select household_id from public.household_memberships
    where user_id = auth.uid()
  ))
  with check ( household_id in (
    select household_id from public.household_memberships
    where user_id = auth.uid()
  ));

-- 2) Daily macro targets, per member (manual, nullable).
alter table public.members add column if not exists kcal_target      int;
alter table public.members add column if not exists protein_target_g int;
alter table public.members add column if not exists carb_target_g    int;
alter table public.members add column if not exists fat_target_g     int;

-- 3) meal-photos storage bucket. Public read (unguessable uuid paths);
--    only authenticated household members can write.
insert into storage.buckets (id, name, public)
  values ('meal-photos', 'meal-photos', true)
on conflict (id) do nothing;

drop policy if exists "meal-photos authenticated insert" on storage.objects;
create policy "meal-photos authenticated insert"
  on storage.objects for insert to authenticated
  with check ( bucket_id = 'meal-photos' );

drop policy if exists "meal-photos authenticated update" on storage.objects;
create policy "meal-photos authenticated update"
  on storage.objects for update to authenticated
  using ( bucket_id = 'meal-photos' );

drop policy if exists "meal-photos authenticated delete" on storage.objects;
create policy "meal-photos authenticated delete"
  on storage.objects for delete to authenticated
  using ( bucket_id = 'meal-photos' );
