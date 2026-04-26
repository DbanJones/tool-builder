import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Per spec.md §4 data model and rules/02-backend.md B1 (id/created_at/updated_at/deleted_at).
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  status: text("status", {
    enum: ["interviewing", "ready", "building", "paused", "done"],
  }).notNull(),
  currentPhase: text("current_phase", { enum: ["A", "B", "C", "D", "E"] }),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lastOpenedAt: integer("last_opened_at").notNull(),
  deletedAt: integer("deleted_at"),
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
