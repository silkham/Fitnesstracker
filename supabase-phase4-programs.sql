-- Phase 4: Peloton Programs — data-driven manifests (replaces hardcoded
-- PROGRAMS array in index.html so multiple programs don't require code edits).
-- No live Programs API (Peloton's gql program resolvers are decommissioned —
-- see program-discover-your-power-manifest memory); manifests are captured via
-- OCR + the peloton-ingest catalog branch, same as peloton_classes.
-- RLS intentionally disabled — matches peloton_classes: shared non-sensitive
-- class-catalog data, not per-household/user data.

create table if not exists public.programs (
  id text primary key,            -- short slug, e.g. 'discover-your-power'
  title text not null,
  subtitle text,
  created_at timestamptz not null default now()
);

create table if not exists public.program_classes (
  program_id text not null references public.programs(id) on delete cascade,
  order_num int not null,
  ride_id text not null,
  title text not null,
  instructor text,
  duration_min int,
  primary key (program_id, order_num)
);

create index if not exists program_classes_ride_id_idx on public.program_classes (ride_id);

-- One-time migration of the "Discover Your Power" manifest that was hardcoded
-- in index.html (Stride v4.2). ride_ids verified against peloton_classes.
insert into public.programs (id, title, subtitle) values
  ('discover-your-power', 'Discover Your Power', 'Power Zone · 5 weeks')
on conflict (id) do nothing;

insert into public.program_classes (program_id, order_num, ride_id, title, instructor, duration_min) values
  ('discover-your-power', 1,  '9571089a5ca540f5960d84dc7d626009', '15 min Intro to Power Zone Ride', 'Matt Wilpers', 15),
  ('discover-your-power', 2,  '3c1dd65ff61c46a69f79ba7ddf4b4b98', '20 min Power Zone Beginner Ride', 'Matt Wilpers', 20),
  ('discover-your-power', 3,  'b2582e39db01477c991a8977aa827555', '10 min FTP Warm Up Ride', 'Denis Morton', 10),
  ('discover-your-power', 4,  'd7869900a95c4a90b594b75673062e58', '20 min FTP Test Ride', 'Denis Morton', 20),
  ('discover-your-power', 5,  '6e513fd6ad1c4d12b829624fa22b38a0', '30 min Power Zone Endurance Ride', 'Christine D''Ercole', 30),
  ('discover-your-power', 6,  '9f8c6ae7009e4e44ad9d9c91fa8d86fd', '20 min Low Impact Ride', 'Matt Wilpers', 20),
  ('discover-your-power', 7,  'a6a39a2560184dec96a87d439048dc94', '30 min Power Zone Endurance Ride', 'Olivia Amato', 30),
  ('discover-your-power', 8,  '780badc02e494abb8ffb8a043235d2b3', '30 min Power Zone Hip Hop Ride', 'Matt Wilpers', 30),
  ('discover-your-power', 9,  '780182ed2ac44246b9e826ad203855a5', '45 min Power Zone Endurance Ride', 'Denis Morton', 45),
  ('discover-your-power', 10, '8e606e35a8634d218f78db1cae4cf2d1', '30 min Power Zone Endurance Ride', 'Olivia Amato', 30),
  ('discover-your-power', 11, '0fd62f3e9aa949eb8d2cd4641ed908b5', '45 min Power Zone Endurance Ride', 'Matt Wilpers', 45),
  ('discover-your-power', 12, '220cdbdbe22242f8b8b8ef0e548a7b53', '30 min Power Zone Ride', 'Christine D''Ercole', 30),
  ('discover-your-power', 13, '595e4d603e5c4bef8272753bbcb1eb3e', '45 min Power Zone Ride', 'Matt Wilpers', 45),
  ('discover-your-power', 14, '48da08b46718486da8ad4419ecb33b2c', '30 min Power Zone Endurance 80s Ride', 'Denis Morton', 30),
  ('discover-your-power', 15, '825de1c5798e41e9bd3b4db7b2cef1b6', '45 min Power Zone Endurance Ride', 'Olivia Amato', 45),
  ('discover-your-power', 16, '73cde88db21142eab43d1b04228ba48e', '45 min Power Zone Ride', 'Denis Morton', 45),
  ('discover-your-power', 17, '66c60c8786524fbea290676d13654c32', '45 min Power Zone Ride', 'Sam Yo', 45),
  ('discover-your-power', 18, '3e33d281e4e949fe9a47daa53b02a55f', '30 min Power Zone Endurance Ride', 'Christine D''Ercole', 30),
  ('discover-your-power', 19, '70050efac905476aa1c3469138ef30c9', '60 min Power Zone Endurance Ride', 'Matt Wilpers', 60),
  ('discover-your-power', 20, 'daf8d640459e4184bd739fba575b8283', '45 min Power Zone Endurance Ride', 'Denis Morton', 45),
  ('discover-your-power', 21, 'a0cb189126bc4d238d21d7016a6b0e3e', '20 min Low Impact Ride', 'Matt Wilpers', 20),
  ('discover-your-power', 22, '0ba916b716cd408c90f51a0934cee5b8', '30 min Power Zone Endurance Rock Ride', 'Christine D''Ercole', 30),
  ('discover-your-power', 23, '6bdfdcefe36d4c7595ff1aae3d50a423', '30 min Power Zone Endurance Pop Ride', 'Olivia Amato', 30),
  ('discover-your-power', 24, '8b42e9fb24784d838f2a2cd73b572e8e', '15 min FTP Warm Up Ride', 'Matt Wilpers', 15),
  ('discover-your-power', 25, '46f4833fd0a44b29acb33e01645388db', '20 min FTP Test Ride', 'Erik Jäger', 20)
on conflict (program_id, order_num) do nothing;
