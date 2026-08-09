# Stage 1: Build the application
FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# Stage 2: Run the production server
FROM oven/bun:1-slim
WORKDIR /app

# Copy built artifacts and necessary metadata/data files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/meta/ ./meta/
COPY --from=builder /app/src/core/constants/ ./src/core/constants/
COPY --from=builder /app/data/ ./data/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/drizzle/ ./drizzle/
COPY --from=builder /app/drizzle.config.ts ./

# COPY ENTIRE node_modules to preserve internal package relative JSON paths
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000
ENV PORT=3000
ENV HOST=0.0.0.0
ENV NODE_ENV=production

CMD ["bun", "run", "dist/index.js"]