-- Phase 5 — Remove the dead Apple Health integration.
--
-- health_metrics (HRV / resting HR / VO2max / respiratory rate) was written ONLY by
-- the health-ingest Edge Function (Apple Health / Health Auto Export). That function
-- is being deleted, leaving this table orphaned. The two features it fed — the
-- "This morning" readiness ring (computeReadiness) and the "You're getting fitter ✨"
-- card (computeFitnessTrend) — are removed in the same change (v4.4).
--
-- Workout intensity metrics (calories / avg_hr / distance_km / total_output_kj on the
-- `workouts` table) come from the PELOTON API, NOT from here, and are unaffected.
--
-- PARKED, not abandoned: if a wearable source (Whoop / Garmin / Oura) is added later,
-- readiness/HRV can be restored from git history and this table recreated from
-- supabase-phase3-readiness.sql.
--
-- Run manually (destructive — DROP). Review before applying.

DROP TABLE IF EXISTS public.health_metrics;
