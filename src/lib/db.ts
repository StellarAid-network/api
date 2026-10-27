import { PrismaClient } from "@prisma/client";
import { config } from "../config";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
  });

if (config.nodeEnv !== "production") {
  globalForPrisma.prisma = prisma;
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
