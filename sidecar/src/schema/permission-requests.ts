import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

import { projects } from "./projects.js";

// Per-project queue of permission prompts the orchestrator-spawned claude
// emits when it wants to perform a tool action that is NOT auto-allowed
// (writes outside `--add-dir`, Bash commands, etc.). The orchestrator MCP
// server inserts a row when claude calls `request_permission`; the
// dashboard's PermissionPromptBanner polls for open rows + presents
// Allow / Deny buttons; on click, resolves the row and the MCP tool
// returns the decision to claude.
//
// `status`:
//   - pending: awaiting novice action
//   - allowed: novice clicked Allow
//   - denied: novice clicked Deny (with optional message back to claude)
//   - expired: 5-minute timeout passed (the MCP tool resolves itself)
export const permissionRequests = sqliteTable("permission_requests", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  toolName: text("tool_name").notNull(),
  inputSummary: text("input_summary").notNull(),
  status: text("status", { enum: ["pending", "allowed", "denied", "expired"] })
    .notNull()
    .default("pending"),
  decisionMessage: text("decision_message"),
  requestedAt: integer("requested_at").notNull(),
  resolvedAt: integer("resolved_at"),
});

export type PermissionRequest = typeof permissionRequests.$inferSelect;
export type NewPermissionRequest = typeof permissionRequests.$inferInsert;
