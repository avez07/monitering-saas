-- Phase 15: Razorpay/Stripe billing.
ALTER TABLE "Subscription" ADD COLUMN "provider" TEXT,
ADD COLUMN "providerSubscriptionId" TEXT,
ADD COLUMN "currency" TEXT,
ADD COLUMN "pastDueSince" TIMESTAMP(3),
ADD COLUMN "providerEventAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Subscription_providerSubscriptionId_key" ON "Subscription"("providerSubscriptionId");

ALTER TABLE "Invoice" ADD COLUMN "subtotal" INTEGER,
ADD COLUMN "tax" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "taxBreakdown" JSONB,
ADD COLUMN "customerGstin" TEXT,
ADD COLUMN "url" TEXT;

ALTER TABLE "Payment" ADD COLUMN "refundedAmount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "WebhookEvent" ALTER COLUMN "orgId" DROP NOT NULL,
ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'mock',
ADD COLUMN "eventId" TEXT;
CREATE UNIQUE INDEX "WebhookEvent_provider_eventId_key" ON "WebhookEvent"("provider", "eventId");

CREATE TABLE "BillingProfile" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "gstin" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BillingProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BillingProfile_orgId_key" ON "BillingProfile"("orgId");
ALTER TABLE "BillingProfile" ADD CONSTRAINT "BillingProfile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
