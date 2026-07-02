-- Phase 9: program_index enrichment for the Add-a-program preview + filters.
-- Non-destructive: adds nullable metadata columns populated by the
-- peloton-ingest {enrichIndex:true} branch (and by importProgram on each add).
--   description  — og:description from the PeloBuddy article
--   class_count  — number of classId slots parsed from the article
--   weeks        — max Week heading (else class_count / 5, rounded up)
--   discipline   — ride|strength|yoga|stretch|run|walk|meditation|other
--   instructor   — headline instructor(s) parsed from the title (comma-joined)
--   level        — Beginner|Intermediate|Advanced (from title) or null
--   language     — en|de|es (from title tag; en default)
--   enriched_at  — set when a row has been enriched (drives batch backfill)

alter table public.program_index add column if not exists description text;
alter table public.program_index add column if not exists class_count int;
alter table public.program_index add column if not exists weeks int;
alter table public.program_index add column if not exists discipline text;
alter table public.program_index add column if not exists instructor text;
alter table public.program_index add column if not exists level text;
alter table public.program_index add column if not exists language text;
alter table public.program_index add column if not exists enriched_at timestamptz;
