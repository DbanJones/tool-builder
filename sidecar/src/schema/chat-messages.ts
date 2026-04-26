import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

import { projects } from "./projects.js";

// Per-project chat transcript so the interview UI can rehydrate the
// conversation on reload (UX2 from the user's first live test). The DB
// already has the structured `answers` table for the spec-rebuilding
// view; this table is the verbatim chat surface.
//
// `role` mirrors the OpenAI/Anthropic chat shape (user | assistant).
export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  text: text("text").notNull(),
  createdAt: integer("created_at").notNull(),
});

export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
