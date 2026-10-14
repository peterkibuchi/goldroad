/**
 * A D1 binding backed by in-memory SQLite, with every migration in `drizzle/`
 * applied. Enough of D1's surface for drizzle's d1 driver (prepare/bind with
 * run/all/raw, and batch), so a test can run the real queries against the real
 * schema instead of asserting on `.toSQL()` strings.
 */

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const MIGRATIONS = new URL("../../../drizzle/", import.meta.url);

/** The migration files, in the order they apply. */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function applyMigrations(sqlite: DatabaseSync, files: string[]) {
  for (const file of files) {
    for (const statement of readFileSync(new URL(file, MIGRATIONS), "utf8")
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean))
      sqlite.exec(statement);
  }
}

class Statement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly params: SQLInputValue[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new Statement(this.sqlite, this.sql, params as SQLInputValue[]);
  }

  async run() {
    const result = this.sqlite.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async all() {
    return {
      success: true,
      results: this.sqlite.prepare(this.sql).all(...this.params),
    };
  }

  async raw() {
    const stmt = this.sqlite.prepare(this.sql);
    stmt.setReturnArrays(true);
    return stmt.all(...this.params);
  }
}

export type SqliteD1 = D1Database & { sqlite: DatabaseSync };

export function sqliteD1(): SqliteD1 {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, migrationFiles());
  const d1 = {
    sqlite,
    prepare: (sql: string) => new Statement(sqlite, sql),
    batch: (statements: Statement[]) =>
      Promise.all(statements.map((statement) => statement.all())),
  };
  return d1 as unknown as SqliteD1;
}
