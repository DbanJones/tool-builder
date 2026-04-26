import { defineConfig } from "drizzle-kit";

// drizzle-kit only — used for `pnpm drizzle-kit generate`. Runtime DB connection
// lives in src/db.ts; the path is provided via CLI args from the Tauri shell.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: ".builder/builder.db",
  },
  strict: true,
});
