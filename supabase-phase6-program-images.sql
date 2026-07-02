-- Phase 6: overarching program artwork.
-- programs.image_url: the program's official hero image. Either an absolute
-- https URL or a path relative to the app root (e.g. img/programs/<id>.jpg
-- committed to the repo and served by GitHub Pages). The app falls back to
-- the first class's peloton_classes.image_url, then the instructor photo,
-- then a gradient — so this column is optional per program.
alter table public.programs add column if not exists image_url text;

update public.programs
   set image_url = 'img/programs/discover-your-power.jpg'
 where id = 'discover-your-power';
