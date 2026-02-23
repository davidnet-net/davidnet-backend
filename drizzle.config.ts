import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/core/database/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: "postgres://" + Bun.env.DB_USER! + ":" + Bun.env.DB_PASSWORD! + "@localhost:5432/" + Bun.env.DB_NAME,
  },
  schemaFilter: ["public", "auth"],
});