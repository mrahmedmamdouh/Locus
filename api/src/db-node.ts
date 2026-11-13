import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db, SqlValue } from './db';

/** node:sqlite adapter. `path` ':memory:' gives a fresh database (tests). */
export function openNodeDb(path: string): Db & { migrate(dir: string): void; close(): void } {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  const prep = (sql: string) => db.prepare(sql);
  return {
    async all<T>(sql: string, params: SqlValue[] = []) {
      return prep(sql).all(...params) as T[];
    },
    async first<T>(sql: string, params: SqlValue[] = []) {
      return (prep(sql).get(...params) as T | undefined) ?? null;
    },
    async run(sql: string, params: SqlValue[] = []) {
      return { changes: Number(prep(sql).run(...params).changes) };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        for (const s of statements) prep(s.sql).run(...(s.params ?? []));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    /** Applies migrations/*.sql in name order, once each (D1 uses `wrangler d1 migrations apply`). */
    migrate(dir: string) {
      db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      const done = new Set((db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name));
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
        if (done.has(f)) continue;
        db.exec('BEGIN');
        try {
          db.exec(readFileSync(join(dir, f), 'utf8'));
          db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }
    },
    close() {
      db.close();
    },
  };
}
