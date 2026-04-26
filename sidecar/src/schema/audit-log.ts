import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Per spec.md §4 data model and rules/02-backend.md B3.
// `actor_id` defaults to "novice" because per B13 there is no user account; the
// field is preserved for forward compatibility and to match B3's contract.
export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").notNull().default("novice"),
  action: text("action").notNull(),
  targetId: text("target_id"),
  payload: text("payload").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
