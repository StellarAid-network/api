-- CreateTable
CREATE TABLE "ModerationAuditLog" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "moderator" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" "ReportTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "previousStatus" "ReportStatus" NOT NULL,
    "newStatus" "ReportStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModerationAuditLog_reportId_idx" ON "ModerationAuditLog"("reportId");

-- CreateIndex
CREATE INDEX "ModerationAuditLog_moderator_createdAt_idx" ON "ModerationAuditLog"("moderator", "createdAt");
