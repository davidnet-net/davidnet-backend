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

# Install ffmpeg (required for get-video-duration on the backend)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Copy built server and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/meta/ ./meta/
COPY --from=builder /app/src/core/constants/ ./src/core/constants/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/drizzle/ ./drizzle/
COPY --from=builder /app/drizzle.config.ts ./

# FIX: Explicitly grant execute permissions to the ffprobe binary
RUN chmod +x /app/node_modules/@ffprobe-installer/linux-x64/ffprobe

EXPOSE 3000
ENV PORT=3000
ENV HOST=0.0.0.0
ENV NODE_ENV=production

CMD ["bun", "run", "build/index.js"]