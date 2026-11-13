/**
 * The small database interface the API needs. Two adapters implement it with the same SQL:
 * Cloudflare D1 (production, see d1.ts) and node:sqlite (local runs and tests, see db-node.ts).
 */
export type SqlValue = string | number | null;

export interface Db {
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  /** Runs the statements atomically. */
  batch(statements: { sql: string; params?: SqlValue[] }[]): Promise<void>;
}
