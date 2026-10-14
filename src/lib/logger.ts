import pino, { type LoggerOptions } from "pino";
import { config } from "../config";

const options: LoggerOptions = {
  level: config.logLevel,
  base: { service: "stellaraid-api" },
  redact: {
    paths: [
      "req.headers.authorization",
      "SEP10_SIGNING_SECRET",
      "JWT_SECRET",
      "*.sep10SigningSecret",
      "*.jwtSecret",
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
