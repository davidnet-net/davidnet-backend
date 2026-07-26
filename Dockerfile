FROM oven/bun:latest AS builder
WORKDIR /app

COPY package.json bun.lock* ./

RUN bun install --frozen-lockfile --ci

COPY . .

RUN bun run build

FROM oven/bun:distroless AS runtime
WORKDIR /app

# 1. Copy package.json and node_modules so scripts and dependencies (like drizzle-kit) exist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

# 2. Copy build output and constants
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/src/core/constants/ ./src/core/constants/

# 3. Copy your Drizzle migration folder and config (adjust path if your migrations folder is named differently)
COPY --from=builder /app/drizzle/ ./drizzle/
COPY --from=builder /app/drizzle.config.ts ./

USER 1000
EXPOSE 3000

ENTRYPOINT ["bun", "run", "index.js"]