import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as path from "node:path";

import * as schema from "./schema/index.js";

type Db = BetterSQLite3Database<typeof schema>;

let dbInstance: Db | null = null;

export function getDb(): Db {
  if (!dbInstance) {
    throw new Error("DB not initialised; call initDb() before serving requests");
  }
  return dbInstance;
}

export interface InitDbOptions {
  dbPath: string;
  migrationsFolder: string;
}

export function initDb({ dbPath, migrationsFolder }: InitDbOptions): Db {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });

  dbInstance = db;
  return db;
}

/** Test-only: tear down the DB connection so a fresh init can happen. */
export function _resetDb(): void {
  dbInstance = null;
}

export { schema };
