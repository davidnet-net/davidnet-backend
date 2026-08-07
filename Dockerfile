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

# Copy built SvelteKit server and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000
ENV PORT=3000
ENV HOST=0.0.0.0

CMD ["bun", "run", "build/index.js"]