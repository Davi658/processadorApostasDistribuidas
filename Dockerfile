FROM oven/bun:1.4.3 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4.3 AS base
WORKDIR /app
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun infra ./infra
USER bun

# Estágio dedicado para execução de testes em contêiner
FROM base AS tester
USER root
RUN mkdir -p /app/docs/evidence /app/.data && chown -R bun:bun /app/docs /app/.data
USER bun
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun tests ./tests
CMD ["bun", "run", "test"]

# Estágio de runtime da API em produção (preserva imagem original da API)
FROM base AS runtime
ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "run", "start"]
