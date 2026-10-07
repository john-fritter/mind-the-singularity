# Mind: the Singularity: the site, /mcp and the server's clock in one
# process, run directly with tsx (as Fritter Board is). No build step.
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
# tsx is needed at runtime, so dev dependencies stay installed.
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY config ./config
COPY personas ./personas
COPY migrations ./migrations
COPY scripts ./scripts
COPY src ./src

RUN addgroup --system --gid 1001 mind && adduser --system --uid 1001 --ingroup mind mind
USER mind

# Listens on every interface inside the container; the compose file decides who can reach it.
ENV HOST=0.0.0.0
ENV PORT=3111
EXPOSE 3111
CMD ["node", "--import", "tsx", "src/server.ts"]
