-- C.2: host kind (server | docker-host), set from the setup profile.
ALTER TABLE "Agent" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'server';
