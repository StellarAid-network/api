-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('VISIBLE', 'HIDDEN', 'DELETED');

-- CreateEnum
CREATE TYPE "ReportTargetType" AS ENUM ('POST', 'COMMENT', 'REQUEST', 'USER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'REVIEWING', 'ACTIONED', 'DISMISSED');

-- CreateTable
CREATE TABLE "User" (
    "address" TEXT NOT NULL,
    "displayName" TEXT,
    "bio" TEXT,
    "avatarHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "Follow" (
    "id" TEXT NOT NULL,
    "followerAddress" TEXT NOT NULL,
    "followeeAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mediaHashes" TEXT[],
    "status" "ContentStatus" NOT NULL DEFAULT 'VISIBLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'VISIBLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "reporter" TEXT NOT NULL,
    "targetType" "ReportTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpRequest" (
    "id" BIGINT NOT NULL,
    "creator" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "goal" BIGINT NOT NULL,
    "raised" BIGINT NOT NULL DEFAULT 0,
    "deadline" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HelpRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Milestone" (
    "id" TEXT NOT NULL,
    "requestId" BIGINT NOT NULL,
    "index" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "evidenceHash" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contribution" (
    "id" TEXT NOT NULL,
    "requestId" BIGINT NOT NULL,
    "contributor" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "ledger" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Giveaway" (
    "id" TEXT NOT NULL,
    "balanceId" TEXT NOT NULL,
    "creator" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "claimants" TEXT[],
    "predicates" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Giveaway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiveawayClaim" (
    "id" TEXT NOT NULL,
    "balanceId" TEXT NOT NULL,
    "claimer" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "ledger" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiveawayClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReputationEvent" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "newScore" INTEGER NOT NULL,
    "refId" TEXT NOT NULL,
    "ledger" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReputationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attestation" (
    "id" TEXT NOT NULL,
    "attestor" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attestation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexerCursor" (
    "stream" TEXT NOT NULL,
    "lastLedger" BIGINT NOT NULL DEFAULT 0,
    "lastCursor" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerCursor_pkey" PRIMARY KEY ("stream")
);

-- CreateTable
CREATE TABLE "ProcessedEvent" (
    "eventId" TEXT NOT NULL,
    "ledger" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE INDEX "Follow_followeeAddress_idx" ON "Follow"("followeeAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerAddress_followeeAddress_key" ON "Follow"("followerAddress", "followeeAddress");

-- CreateIndex
CREATE INDEX "Post_status_createdAt_idx" ON "Post"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Post_author_idx" ON "Post"("author");

-- CreateIndex
CREATE INDEX "Comment_postId_createdAt_idx" ON "Comment"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "Report_status_createdAt_idx" ON "Report"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Report_targetType_targetId_idx" ON "Report"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "HelpRequest_status_deadline_idx" ON "HelpRequest"("status", "deadline");

-- CreateIndex
CREATE INDEX "HelpRequest_creator_idx" ON "HelpRequest"("creator");

-- CreateIndex
CREATE UNIQUE INDEX "Milestone_requestId_index_key" ON "Milestone"("requestId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "Contribution_txHash_key" ON "Contribution"("txHash");

-- CreateIndex
CREATE INDEX "Contribution_requestId_idx" ON "Contribution"("requestId");

-- CreateIndex
CREATE INDEX "Contribution_contributor_idx" ON "Contribution"("contributor");

-- CreateIndex
CREATE UNIQUE INDEX "Giveaway_balanceId_key" ON "Giveaway"("balanceId");

-- CreateIndex
CREATE INDEX "Giveaway_status_idx" ON "Giveaway"("status");

-- CreateIndex
CREATE INDEX "Giveaway_creator_idx" ON "Giveaway"("creator");

-- CreateIndex
CREATE UNIQUE INDEX "GiveawayClaim_txHash_key" ON "GiveawayClaim"("txHash");

-- CreateIndex
CREATE INDEX "GiveawayClaim_claimer_idx" ON "GiveawayClaim"("claimer");

-- CreateIndex
CREATE INDEX "ReputationEvent_subject_idx" ON "ReputationEvent"("subject");

-- CreateIndex
CREATE INDEX "Attestation_subject_idx" ON "Attestation"("subject");

-- CreateIndex
CREATE INDEX "ProcessedEvent_ledger_idx" ON "ProcessedEvent"("ledger");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_author_fkey" FOREIGN KEY ("author") REFERENCES "User"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_author_fkey" FOREIGN KEY ("author") REFERENCES "User"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "HelpRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "HelpRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiveawayClaim" ADD CONSTRAINT "GiveawayClaim_balanceId_fkey" FOREIGN KEY ("balanceId") REFERENCES "Giveaway"("balanceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Full-text search indexes (not expressible in the Prisma schema)
CREATE INDEX "Post_body_fts_idx" ON "Post" USING GIN (to_tsvector('english', "body"));
CREATE INDEX "HelpRequest_metadata_gin_idx" ON "HelpRequest" USING GIN ("metadata" jsonb_path_ops);

