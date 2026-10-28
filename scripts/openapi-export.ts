import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

process.env["NODE_ENV"] ??= "test";
process.env["DATABASE_URL"] ??= "postgresql://stellaraid:stellaraid@localhost:5432/stellaraid?schema=public";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["STELLAR_NETWORK"] ??= "testnet";
process.env["SOROBAN_RPC_URL"] ??= "https://soroban-testnet.stellar.org";
process.env["HORIZON_URL"] ??= "https://horizon-testnet.stellar.org";
if (!process.env["SEP10_SIGNING_SECRET"] || process.env["SEP10_SIGNING_SECRET"].startsWith("SDUMMY")) {
  process.env["SEP10_SIGNING_SECRET"] = Keypair.random().secret();
}
process.env["SEP10_HOME_DOMAIN"] ??= "localhost:3000";
process.env["JWT_SECRET"] ??= "openapi-export-ephemeral-secret-32-chars";
process.env["CORS_ORIGINS"] ??= "http://localhost:3000";

async function main(): Promise<void> {
  const { buildApp } = await import("../src/app");
  const { prisma } = await import("../src/lib/db");
  const { redis } = await import("../src/lib/redis");
  const app = await buildApp();
  await app.ready();

  const spec = app.swagger();
  const outPath = resolve(process.cwd(), "openapi/openapi.json");

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");

  await app.close();
  await prisma.$disconnect();
  redis.disconnect();

  process.stdout.write(`Wrote ${outPath}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
