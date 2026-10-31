FROM node:20-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /workspace

FROM base AS build
COPY sdk ./sdk
RUN cd sdk && pnpm install --frozen-lockfile && pnpm build

COPY api ./api
RUN cd api && pnpm install --frozen-lockfile && pnpm build

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /workspace/api
COPY --from=build /workspace/sdk /workspace/sdk
COPY --from=build /workspace/api/package.json /workspace/api/pnpm-lock.yaml ./
COPY --from=build /workspace/api/prisma ./prisma
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
  && pnpm prisma generate
COPY --from=build /workspace/api/dist ./dist
EXPOSE 4000
CMD ["node", "dist/server.js"]
