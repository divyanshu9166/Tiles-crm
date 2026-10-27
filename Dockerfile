# syntax=docker/dockerfile:1.7

# ─── Stage 1: Dependencies ─────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund --progress=false

# ─── Stage 2: Builder ─────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client
ARG DATABASE_URL="postgresql://postgres:postgres@localhost:5432/furniturecrm"
ENV DATABASE_URL=$DATABASE_URL
RUN --mount=type=cache,target=/root/.npm npx prisma generate

# Build Next.js (standalone output)
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ─── Stage 3: Runner ──────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install curl (healthcheck), gosu (permissions), and libgomp1 (required by ONNX runtime)
RUN apt-get update && apt-get install -y --no-install-recommends curl gosu libgomp1 tzdata && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy standalone output
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./

# Ensure uploads directory exists (permissions fixed at runtime by entrypoint)
RUN mkdir -p ./uploads
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy Prisma files for migrations/seed
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/.bin ./node_modules/.bin

# Copy pg adapter + dependencies (needed at runtime for PrismaPg adapter)
COPY --from=builder /app/node_modules/pg ./node_modules/pg
COPY --from=builder /app/node_modules/pg-pool ./node_modules/pg-pool
COPY --from=builder /app/node_modules/pg-protocol ./node_modules/pg-protocol
COPY --from=builder /app/node_modules/pg-types ./node_modules/pg-types
COPY --from=builder /app/node_modules/pgpass ./node_modules/pgpass
COPY --from=builder /app/node_modules/pg-int8 ./node_modules/pg-int8
COPY --from=builder /app/node_modules/pg-connection-string ./node_modules/pg-connection-string
COPY --from=builder /app/node_modules/pg-cloudflare ./node_modules/pg-cloudflare
COPY --from=builder /app/node_modules/postgres-array ./node_modules/postgres-array
COPY --from=builder /app/node_modules/postgres-bytea ./node_modules/postgres-bytea
COPY --from=builder /app/node_modules/postgres-date ./node_modules/postgres-date
COPY --from=builder /app/node_modules/postgres-interval ./node_modules/postgres-interval
COPY --from=builder /app/node_modules/split2 ./node_modules/split2

# Copy @xenova/transformers + ONNX runtime (serverExternalPackages — NOT bundled
# by Next.js standalone, so they must exist as real node_modules at runtime).
# These power the local multilingual-e5-small embedding model.
COPY --from=builder /app/node_modules/@xenova ./node_modules/@xenova
COPY --from=builder /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node
COPY --from=builder /app/node_modules/onnxruntime-common ./node_modules/onnxruntime-common
COPY --from=builder /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder /app/node_modules/flatbuffers ./node_modules/flatbuffers
COPY --from=builder /app/node_modules/long ./node_modules/long
COPY --from=builder /app/node_modules/protobufjs ./node_modules/protobufjs

# Copy entrypoint that fixes volume permissions then drops to nextjs user
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Keep as root — entrypoint will chown /app/uploads then exec as nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Indian business days: "today", month ranges and printed times use IST.
ENV TZ=Asia/Kolkata

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
