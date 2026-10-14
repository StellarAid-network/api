import fp from "fastify-plugin";

export const requestIdPlugin = fp(
  async (app) => {
    app.addHook("onRequest", async (request, reply) => {
      reply.header("x-request-id", request.id);
    });
  },
  { name: "request-id" },
);
