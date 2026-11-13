import type { Db, SqlValue } from './db';

/** The parts of Cloudflare's D1 binding we use (avoids a dependency on @cloudflare/workers-types). */
export interface D1PreparedStatement {
  bind(...values: SqlValue[]): D1PreparedStatement;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}

export function d1Db(d1: D1Database): Db {
  const stmt = (sql: string, params: SqlValue[] = []) => d1.prepare(sql).bind(...params);
  return {
    async all<T>(sql: string, params?: SqlValue[]) {
      return (await stmt(sql, params).all<T>()).results;
    },
    async first<T>(sql: string, params?: SqlValue[]) {
      return stmt(sql, params).first<T>();
    },
    async run(sql: string, params?: SqlValue[]) {
      return { changes: (await stmt(sql, params).run()).meta.changes };
    },
    async batch(statements) {
      await d1.batch(statements.map((s) => stmt(s.sql, s.params)));
    },
  };
}
