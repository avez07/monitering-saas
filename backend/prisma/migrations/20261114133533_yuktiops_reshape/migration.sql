/*
  Warnings:

  - You are about to drop the column `demo` on the `Agent` table. All the data in the column will be lost.
  - You are about to drop the column `containers` on the `SubscriptionPlan` table. All the data in the column will be lost.
  - You are about to drop the column `currency` on the `SubscriptionPlan` table. All the data in the column will be lost.
  - You are about to drop the column `logGb` on the `SubscriptionPlan` table. All the data in the column will be lost.
  - You are about to drop the column `metricsGb` on the `SubscriptionPlan` table. All the data in the column will be lost.
  - You are about to drop the column `price` on the `SubscriptionPlan` table. All the data in the column will be lost.
  - You are about to drop the column `servers` on the `SubscriptionPlan` table. All the data in the column will be lost.
  - You are about to drop the column `traceGb` on the `SubscriptionPlan` table. All the data in the column will be lost.
  - You are about to drop the column `demo` on the `UptimeMonitor` table. All the data in the column will be lost.
  - You are about to drop the `AgentConfigVersion` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Alert` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Permission` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PlanFeature` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Role` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `RolePermission` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UsageAggregate` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UsageRecord` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `extraServerInrPaise` to the `SubscriptionPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `extraServerUsdCents` to the `SubscriptionPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `includedServers` to the `SubscriptionPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `minCheckIntervalSeconds` to the `SubscriptionPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `monitors` to the `SubscriptionPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `priceInrPaise` to the `SubscriptionPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `priceUsdCents` to the `SubscriptionPlan` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "AgentConfigVersion" DROP CONSTRAINT "AgentConfigVersion_agentId_fkey";

-- DropForeignKey
ALTER TABLE "AgentConfigVersion" DROP CONSTRAINT "AgentConfigVersion_orgId_fkey";

-- DropForeignKey
ALTER TABLE "Alert" DROP CONSTRAINT "Alert_orgId_fkey";

-- DropForeignKey
ALTER TABLE "AlertIncident" DROP CONSTRAINT "AlertIncident_orgId_fkey";

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_orgId_fkey";

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_orgId_fkey";

-- DropForeignKey
ALTER TABLE "NotificationChannel" DROP CONSTRAINT "NotificationChannel_orgId_fkey";

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_orgId_fkey";

-- DropForeignKey
ALTER TABLE "PlanFeature" DROP CONSTRAINT "PlanFeature_planId_fkey";

-- DropForeignKey
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_permissionId_fkey";

-- DropForeignKey
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_roleId_fkey";

-- DropForeignKey
ALTER TABLE "UptimeCheck" DROP CONSTRAINT "UptimeCheck_orgId_fkey";

-- DropForeignKey
ALTER TABLE "UsageAggregate" DROP CONSTRAINT "UsageAggregate_orgId_fkey";

-- DropForeignKey
ALTER TABLE "UsageRecord" DROP CONSTRAINT "UsageRecord_orgId_fkey";

-- DropForeignKey
ALTER TABLE "WebhookEvent" DROP CONSTRAINT "WebhookEvent_orgId_fkey";

-- AlterTable
ALTER TABLE "Agent" DROP COLUMN "demo";

-- AlterTable
ALTER TABLE "SubscriptionPlan" DROP COLUMN "containers",
DROP COLUMN "currency",
DROP COLUMN "logGb",
DROP COLUMN "metricsGb",
DROP COLUMN "price",
DROP COLUMN "servers",
DROP COLUMN "traceGb",
ADD COLUMN     "extraServerInrPaise" INTEGER NOT NULL,
ADD COLUMN     "extraServerUsdCents" INTEGER NOT NULL,
ADD COLUMN     "includedServers" INTEGER NOT NULL,
ADD COLUMN     "minCheckIntervalSeconds" INTEGER NOT NULL,
ADD COLUMN     "monitors" INTEGER NOT NULL,
ADD COLUMN     "priceInrPaise" INTEGER NOT NULL,
ADD COLUMN     "priceUsdCents" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "UptimeMonitor" DROP COLUMN "demo";

-- DropTable
DROP TABLE "AgentConfigVersion";

-- DropTable
DROP TABLE "Alert";

-- DropTable
DROP TABLE "Permission";

-- DropTable
DROP TABLE "PlanFeature";

-- DropTable
DROP TABLE "Role";

-- DropTable
DROP TABLE "RolePermission";

-- DropTable
DROP TABLE "UsageAggregate";

-- DropTable
DROP TABLE "UsageRecord";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT NOT NULL DEFAULT '',
    "ip" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerLease" (
    "id" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerLease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertIncident" ADD CONSTRAINT "AlertIncident_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationChannel" ADD CONSTRAINT "NotificationChannel_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UptimeCheck" ADD CONSTRAINT "UptimeCheck_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
