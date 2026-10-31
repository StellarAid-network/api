import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ALICE = "GBTYIQPBLDAXZ3DGFY5KAYFHRVGOF5V5GU263RTRVQQOAIICCW5S4VEQ";
const AMINA = "GCFGKLCBV5IGJYGRR7FJNU53HFV5674PMQNNJT6HRAFGUAHZ7V3ZELXR";
const CHIDI = "GD5DJQDDBKGAYNEAXU562HYGOOSYAEOO6AS53PZXBOZGCP5M2OPGMZV3";
const USDC_TESTNET = "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function canonicalHash(metadata: {
  title: string;
  description: string;
  tags: string[];
  media: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: metadata.title,
        description: metadata.description,
        tags: metadata.tags,
        media: metadata.media,
      }),
    )
    .digest("hex");
}

async function main(): Promise<void> {
  // 1. Users
  for (const user of [
    {
      address: ALICE,
      displayName: "Adaeze Okonkwo",
      bio: "Community solar coordinator and verified mutual-aid organizer in Lagos.",
      avatarHash: null,
    },
    {
      address: AMINA,
      displayName: "Amina Yusuf",
      bio: "Nurse practitioner verifying local clinic equipment requests.",
      avatarHash: null,
    },
    {
      address: CHIDI,
      displayName: "Chidi Nwosu",
      bio: "Open-source developer supporting student connectivity grants.",
      avatarHash: null,
    },
  ]) {
    await prisma.user.upsert({
      where: { address: user.address },
      update: { displayName: user.displayName, bio: user.bio },
      create: user,
    });
  }

  // 2. Follows
  await prisma.follow.upsert({
    where: {
      followerAddress_followeeAddress: {
        followerAddress: CHIDI,
        followeeAddress: ALICE,
      },
    },
    update: {},
    create: {
      followerAddress: CHIDI,
      followeeAddress: ALICE,
    },
  });

  // 3. Posts & Comments
  const post1 = await prisma.post.upsert({
    where: { id: "seed-post-solar-clinic" },
    update: {},
    create: {
      id: "seed-post-solar-clinic",
      author: ALICE,
      body: "Solar inverter installation Milestone #1 is complete at the Surulere Maternal Clinic! #solar #health",
      mediaHashes: [],
      status: "VISIBLE",
    },
  });

  await prisma.comment.upsert({
    where: { id: "seed-comment-amina-1" },
    update: {},
    create: {
      id: "seed-comment-amina-1",
      postId: post1.id,
      author: AMINA,
      body: "Verified inverter serial numbers and battery voltage on-site today.",
      status: "VISIBLE",
    },
  });

  // 4. Testnet-shaped HelpRequest + Milestones + Contributions
  const req1Meta = {
    title: "Surulere Maternal Clinic Solar Backup System",
    description:
      "Install a 5kVA lithium-solar backup system for vaccine cold-chain refrigeration and night deliveries.",
    tags: ["solar", "health", "lagos"],
    media: [],
  };

  await prisma.helpRequest.upsert({
    where: { id: 1n },
    update: {
      raised: 350_0000000n,
      status: "open",
      metadata: req1Meta,
    },
    create: {
      id: 1n,
      creator: ALICE,
      token: USDC_TESTNET,
      goal: 500_0000000n,
      raised: 350_0000000n,
      deadline: new Date(Date.now() + 14 * 86_400_000),
      status: "open",
      contentHash: canonicalHash(req1Meta),
      metadata: req1Meta,
    },
  });

  await prisma.milestone.upsert({
    where: { requestId_index: { requestId: 1n, index: 0 } },
    update: {},
    create: {
      requestId: 1n,
      index: 0,
      amount: 300_0000000n,
      status: "pending",
      evidenceHash: null,
    },
  });

  await prisma.milestone.upsert({
    where: { requestId_index: { requestId: 1n, index: 1 } },
    update: {},
    create: {
      requestId: 1n,
      index: 1,
      amount: 200_0000000n,
      status: "pending",
      evidenceHash: null,
    },
  });

  await prisma.contribution.upsert({
    where: { id: "seed-contrib-1" },
    update: {},
    create: {
      id: "seed-contrib-1",
      requestId: 1n,
      contributor: CHIDI,
      amount: 350_0000000n,
      txHash: "9f8e7d6c5b4a392817161514131211100f0e0d0c0b0a09080706050403020100",
      ledger: 541_200n,
    },
  });

  // 5. Claimable-balance Giveaway
  await prisma.giveaway.upsert({
    where: {
      balanceId: "00000000a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    },
    update: {},
    create: {
      balanceId: "00000000a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      creator: AMINA,
      asset: USDC_TESTNET,
      amount: 100_0000000n,
      claimants: [ALICE, CHIDI],
      predicates: [{ destination: CHIDI, predicate: { unconditional: true } }],
      status: "open",
    },
  });

  // 6. Reputation, Attestations, Notifications & Indexer Cursors
  await prisma.reputationEvent.upsert({
    where: { id: "seed-rep-alice-1" },
    update: {},
    create: {
      id: "seed-rep-alice-1",
      subject: ALICE,
      delta: 25,
      newScore: 75,
      refId: "request:1",
      ledger: 541_205n,
    },
  });

  await prisma.attestation.upsert({
    where: { id: "seed-attestation-1" },
    update: {},
    create: {
      id: "seed-attestation-1",
      attestor: AMINA,
      subject: "1",
      kind: "verified_need",
      contentHash: canonicalHash(req1Meta),
      expiresAt: new Date(Date.now() + 90 * 86_400_000),
      revoked: false,
    },
  });

  await prisma.notification.upsert({
    where: { id: "seed-notif-alice-1" },
    update: {},
    create: {
      id: "seed-notif-alice-1",
      recipient: ALICE,
      kind: "contribution_received",
      title: "New contribution to Request #1",
      body: "350.00 USDC contributed into Soroban escrow.",
      refId: "1",
      read: false,
    },
  });

  for (const stream of [
    "soroban:help_request",
    "soroban:reputation",
    "soroban:attestation",
    "horizon:giveaways",
  ]) {
    await prisma.indexerCursor.upsert({
      where: { stream },
      update: { lastLedger: 541_210n },
      create: { stream, lastLedger: 541_210n, lastCursor: "541210-0" },
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
