-- Yukti platform admin: staff flag, disabled users, suspended organizations and the platform audit log.
ALTER TABLE "User" ADD COLUMN "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "disabledAt" TIMESTAMP(3);

ALTER TABLE "Organization" ADD COLUMN "suspendedAt" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "suspendReason" TEXT;

CREATE TABLE "PlatformAuditLog" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformAuditLog_createdAt_idx" ON "PlatformAuditLog"("createdAt");
CREATE INDEX "PlatformAuditLog_targetType_targetId_createdAt_idx" ON "PlatformAuditLog"("targetType", "targetId", "createdAt");

ALTER TABLE "PlatformAuditLog" ADD CONSTRAINT "PlatformAuditLog_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
