// drizzle-kit configuration: `npm run db:generate -w @pxdict/gateway` writes a new migration into
// ./drizzle from src/db/schema.ts. Released migrations are never edited (AGENTS.md §5).
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
