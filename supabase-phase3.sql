-- ============================================================
-- Phase 3 — workout intensity metrics from Apple Health
-- Run once in Supabase → SQL Editor.
-- ============================================================

alter table public.workouts add column if not exists calories     int;
alter table public.workouts add column if not exists avg_hr       int;
alter table public.workouts add column if not exists max_hr       int;
alter table public.workouts add column if not exists distance_km  numeric(6,2);
