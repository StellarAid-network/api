process.env.NODE_ENV = "test";
process.env.PORT = "4000";
process.env.LOG_LEVEL = "silent";

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://stellaraid:stellaraid@localhost:5432/stellaraid?schema=public";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";

process.env.SEP10_SIGNING_SECRET = "SDUMMY0000000000000000000000000000000000000000000000000000";
process.env.SEP10_HOME_DOMAIN = "localhost:3000";

process.env.JWT_SECRET = "test-secret";
process.env.CORS_ORIGINS = "http://localhost:3000";
