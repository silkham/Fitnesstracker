-- Phase 7: real week/day structure on program classes.
-- Programs aren't uniformly "5 classes/week, one per day" — Stronger You is
-- 4 weeks with multi-class days (Benchmark + Stretch). Nullable: when null the
-- app falls back to the legacy 5-per-week slicing.
alter table public.program_classes
  add column if not exists week int,
  add column if not exists day int;

-- Discover Your Power: 5 classes/week, one per day (order-derived).
update public.program_classes
   set week = ((order_num - 1) / 5) + 1,
       day  = ((order_num - 1) % 5) + 1
 where program_id = 'discover-your-power';

-- The Stronger You: week/day from the PeloBuddy schedule (rest days 3+6/7 skipped).
update public.program_classes
   set week = case
         when order_num between 1  and 10 then 1
         when order_num between 11 and 19 then 2
         when order_num between 20 and 28 then 3
         else 4
       end,
       day = case
         when order_num in (1,2,3)      then 1
         when order_num in (4,5)        then 2
         when order_num in (6,7,8)      then 4
         when order_num in (9,10)       then 5
         when order_num in (11,12)      then 1
         when order_num in (13,14)      then 2
         when order_num in (15,16,17)   then 4
         when order_num in (18,19)      then 5
         when order_num in (20,21)      then 1
         when order_num in (22,23)      then 2
         when order_num in (24,25,26)   then 4
         when order_num in (27,28)      then 5
         when order_num in (29,30)      then 1
         when order_num in (31,32)      then 2
         when order_num in (33,34,35)   then 4
         else 5
       end
 where program_id = 'stronger-you';
