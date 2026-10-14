import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildApp } from "../src/app";
import { prisma } from "../src/lib/db";
import { redis } from "../src/lib/redis";

async function main(): Promise<void> {
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
