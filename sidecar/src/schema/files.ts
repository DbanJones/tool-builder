import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

import { projects } from "./projects.js";

// Per spec.md §4 data model.
// `kind` mirrors lib/files/types.ts IngestedFileKind.
// `stored_path` is the absolute path of the saved copy under
// {project}/inputs/. `summary` is the human-readable description that the
// chat shows to the novice ("I see a wireframe with 3 panels..."), filled in
// by the extractor handler.
export const files = sqliteTable("files", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  originalName: text("original_name").notNull(),
  storedPath: text("stored_path").notNull(),
  kind: text("kind", { enum: ["document", "image", "schema", "data", "url", "unknown"] }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  summary: text("summary"),
  hasPiiWarning: integer("has_pii_warning", { mode: "boolean" }).notNull().default(false),
  ingestedAt: integer("ingested_at").notNull(),
});

export type FileRecord = typeof files.$inferSelect;
export type NewFileRecord = typeof files.$inferInsert;
