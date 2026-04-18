FROM oven/bun:latest AS builder
WORKDIR /app

COPY package.json bun.lock* ./

RUN bun install --frozen-lockfile

COPY . .

RUN bun run build

FROM oven/bun:distroless AS runtime
WORKDIR /app

COPY --from=builder /app/dist/ ./
COPY --from=builder /app/src/core/constants/ ./src/core/constants/

USER 1000
EXPOSE 3000

ENTRYPOINT ["bun", "run", "index.js"]