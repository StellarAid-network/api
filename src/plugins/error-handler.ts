import type { FastifyError, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { ZodError } from "zod";
import { sendProblem } from "../lib/problem";
import { captureException, initSentry } from "../lib/sentry";

function statusOf(error: FastifyError): number {
  if (typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return 500;
}

export const errorHandlerPlugin = fp(
  async (app) => {
    initSentry();

    app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply) => {
      const status = statusOf(error);
      const isServerError = status >= 500;

      if (isServerError) {
        request.log.error({ err: error, reqId: request.id }, "unhandled request error");
        captureException(error, {
          requestId: request.id,
          method: request.method,
          url: request.url,
          userAddress: request.user?.address ?? null,
        });
      } else {
        request.log.warn({ err: error, reqId: request.id }, "request rejected");
      }

      if (error instanceof ZodError) {
        return sendProblem(reply, {
          type: "about:blank",
          title: "Unprocessable Entity",
          status: 422,
          detail: "Request failed validation.",
          instance: request.url,
          requestId: request.id,
          errors: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }

      return sendProblem(reply, {
        type: "about:blank",
        title: isServerError ? "Internal Server Error" : error.name || "Request Error",
        status,
        detail: isServerError ? "An unexpected error occurred." : error.message,
        instance: request.url,
        requestId: request.id,
      });
    });

    app.setNotFoundHandler((request, reply) => {
      return sendProblem(reply, {
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: `Route ${request.method} ${request.url} not found.`,
        instance: request.url,
        requestId: request.id,
      });
    });
  },
  { name: "error-handler" },
);
