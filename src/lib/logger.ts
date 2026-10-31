import pino, { type LoggerOptions } from "pino";
import { config } from "../config";

const options: LoggerOptions = {
  level: config.logLevel,
  base: { service: "stellaraid-api" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'req.headers["x-internal-token"]',
      "SEP10_SIGNING_SECRET",
      "JWT_SECRET",
      "IPFS_PINNING_JWT",
      "*.sep10SigningSecret",
      "*.jwtSecret",
      "*.ipfsPinningJwt",
    ],
    remove: true,
  },
};

if (config.nodeEnv === "development") {
  options.transport = {
    target: "pino-pretty",
    options: { colorize: true, translateTime: "SYS:standard" },
  };
}

export const logger = pino(options);
