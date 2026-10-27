import { loadEnvFile } from "node:process";
import { z } from "zod";

try {
  loadEnvFile();
} catch {
  // No .env file present: rely on the ambient environment.
}

const emptyToUndefined = (value: unknown): unknown => (value === "" ? undefined : value);

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  STELLAR_NETWORK: z.enum(["testnet", "mainnet", "local"]),
  SOROBAN_RPC_URL: z.string().url(),
  HORIZON_URL: z.string().url(),

  SEP10_SIGNING_SECRET: z.string().min(1),
  SEP10_HOME_DOMAIN: z.string().min(1),
  SEP10_WEB_AUTH_DOMAIN: optionalString,

  JWT_SECRET: z.string().min(1),
  JWT_EXPIRES_IN: z.string().default("1h"),

  CORS_ORIGINS: z.string().min(1),

  INDEXER_START_LEDGER: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().nonnegative().optional(),
  ),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),

  IPFS_PINNING_JWT: optionalString,
  SENTRY_DSN: optionalString,
  ADMIN_ADDRESSES: optionalString,
  MIN_ACCOUNT_AGE_SECONDS: z.coerce.number().int().nonnegative().default(0),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  nodeEnv: Env["NODE_ENV"];
  port: number;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  stellarNetwork: Env["STELLAR_NETWORK"];
  sorobanRpcUrl: string;
  horizonUrl: string;
  sep10SigningSecret: string;
  sep10HomeDomain: string;
  sep10WebAuthDomain: string | undefined;
  jwtSecret: string;
  jwtExpiresIn: string;
  corsOrigins: string[];
  indexerStartLedger: number | undefined;
  indexerPollIntervalMs: number;
  ipfsPinningJwt: string | undefined;
  sentryDsn: string | undefined;
  adminAddresses: string[];
  minAccountAgeSeconds: number;
}

export class ConfigError extends Error {
  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ConfigError(issues);
  }

  const env = parsed.data;

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    stellarNetwork: env.STELLAR_NETWORK,
    sorobanRpcUrl: env.SOROBAN_RPC_URL,
    horizonUrl: env.HORIZON_URL,
    sep10SigningSecret: env.SEP10_SIGNING_SECRET,
    sep10HomeDomain: env.SEP10_HOME_DOMAIN,
    sep10WebAuthDomain: env.SEP10_WEB_AUTH_DOMAIN,
    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
    corsOrigins: splitList(env.CORS_ORIGINS),
    indexerStartLedger: env.INDEXER_START_LEDGER,
    indexerPollIntervalMs: env.INDEXER_POLL_INTERVAL_MS,
    ipfsPinningJwt: env.IPFS_PINNING_JWT,
    sentryDsn: env.SENTRY_DSN,
    adminAddresses: splitList(env.ADMIN_ADDRESSES),
    minAccountAgeSeconds: env.MIN_ACCOUNT_AGE_SECONDS,
  };
}

export const config = loadConfig();
