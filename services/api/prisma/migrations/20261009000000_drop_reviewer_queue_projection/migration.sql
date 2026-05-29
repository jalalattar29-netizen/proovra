-- PHASE FINAL CLOSURE — Drop unused reviewer_queue_projections table.
--
-- The reviewer_queue_projections table and its companion Prisma model
-- ReviewerQueueProjection were introduced in 37.97 alongside
-- org_health_projections, but the table was never wired into any
-- service, worker, route, or read path. It is an orphan.
--
-- This migration removes the table (and its index) idempotently. The
-- sister table `org_health_projections` is untouched — it remains the
-- canonical dashboard read model.

DROP TABLE IF EXISTS "reviewer_queue_projections" CASCADE;
