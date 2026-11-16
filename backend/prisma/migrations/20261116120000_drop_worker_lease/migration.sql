-- Workers are coordinated by BullMQ (Redis) now; the database lease is no longer used.
DROP TABLE IF EXISTS "WorkerLease";
