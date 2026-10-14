import type { FastifyReply } from "fastify";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: { path: string; message: string }[];
}

export function sendProblem(reply: FastifyReply, problem: ProblemDetails): FastifyReply {
  return reply.code(problem.status).type("application/problem+json").send(problem);
}
