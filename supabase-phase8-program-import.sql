-- Phase 8: in-app program onboarding (PeloBuddy import pipeline).
-- 1) program_index: the searchable list of ~200+ programs scraped from
--    pelobuddy.com/programs/ (title + article URL only; full manifests are
--    imported on demand). RLS intentionally disabled — shared non-sensitive
--    catalog data, matches programs/peloton_classes.
-- 2) user_programs: which programs a user has added ("My programs").
--    Per-user, RLS enforced via auth.uid().
-- 3) program-art storage bucket: self-hosted hero artwork copied from each
--    article's og:image at import time (public read).

create table if not exists public.program_index (
  slug text primary key,           -- article slug, e.g. 'hannah-corbins-stretching-program'
  title text not null,
  article_url text not null,
  scraped_at timestamptz not null default now()
);

create table if not exists public.user_programs (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  program_id text not null references public.programs(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (user_id, program_id)
);

alter table public.user_programs enable row level security;

drop policy if exists "user_programs_select_own" on public.user_programs;
create policy "user_programs_select_own" on public.user_programs
  for select using (auth.uid() = user_id);

drop policy if exists "user_programs_insert_own" on public.user_programs;
create policy "user_programs_insert_own" on public.user_programs
  for insert with check (auth.uid() = user_id);

drop policy if exists "user_programs_delete_own" on public.user_programs;
create policy "user_programs_delete_own" on public.user_programs
  for delete using (auth.uid() = user_id);

-- Hero artwork bucket (public read; writes only via service role from the
-- import Edge Function).
insert into storage.buckets (id, name, public)
  values ('program-art', 'program-art', true)
on conflict (id) do nothing;

-- Backfill: the two manually onboarded programs belong to Lachlan.
insert into public.user_programs (user_id, program_id)
select u.id, p.program_id
from auth.users u
cross join (values ('discover-your-power'), ('stronger-you')) as p(program_id)
where u.email = 'lachlanmclean1990@gmail.com'
on conflict (user_id, program_id) do nothing;
