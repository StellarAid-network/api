import { buildApp } from "./app";
import { config } from "./config";
import { logger } from "./lib/logger";

async function main(): Promise<void> {
  const app = await buildApp();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "server failed to start");
  process.exit(1);
});
