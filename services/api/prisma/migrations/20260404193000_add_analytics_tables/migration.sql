-- CreateTable
CREATE TABLE "AnalyticsEvent" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "userId" TEXT,
  "sessionId" TEXT NOT NULL,
  "visitorId" TEXT NOT NULL,
  "path" TEXT,
  "referrer" TEXT,
  "country" TEXT,
  "city" TEXT,
  "region" TEXT,
  "device" TEXT,
  "browser" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsSession" (
  "id" TEXT NOT NULL,
  "visitorId" TEXT NOT NULL,
  "userId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "country" TEXT,
  "city" TEXT,
  "device" TEXT,
  "browser" TEXT,

  CONSTRAINT "AnalyticsSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalyticsEvent_eventType_idx" ON "AnalyticsEvent"("eventType");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_userId_idx" ON "AnalyticsEvent"("userId");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_sessionId_idx" ON "AnalyticsEvent"("sessionId");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_createdAt_idx" ON "AnalyticsEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AnalyticsSession_visitorId_idx" ON "AnalyticsSession"("visitorId");

-- CreateIndex
CREATE INDEX "AnalyticsSession_userId_idx" ON "AnalyticsSession"("userId");

-- CreateIndex
CREATE INDEX "AnalyticsSession_startedAt_idx" ON "AnalyticsSession"("startedAt");