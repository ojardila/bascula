/**
 * `node:sqlite` behind the `SqlDatabase` port, so the test suite can drive the
 * real repository — the real settle, the real void, the real migrations —
 * instead of a retyped imitation of them.
 *
 * This file is test-only by intent, but it is not in a `.test.ts` because the
 * golden runner in `packages/shared` uses it too. It is never imported by the
 * app: nothing on the phone reaches `node:sqlite`.
 *
 * `withTransactionSync` is BEGIN / task / COMMIT with ROLLBACK in the catch and
 * no savepoints, which is exactly what expo-sqlite does
 * (`node_modules/expo-sqlite/build/SQLiteDatabase.js`). Making it any safer here
 * would hide from the tests the one thing that matters about it: SQLite has no
 * nested BEGIN, so a transaction opened inside another rolls back the outer one.
 */

import type { DatabaseSync } from "node:sqlite";
import type { SqlDatabase, SqlValue } from "./sqliteRepository.ts";

type Bind = Parameters<ReturnType<DatabaseSync["prepare"]>["all"]>;

export function nodeSqlite(db: DatabaseSync): SqlDatabase {
  const bind = (params: SqlValue[]) => params as unknown as Bind;
  return {
    getAllSync<T>(sql: string, params: SqlValue[]): T[] {
      return db.prepare(sql).all(...bind(params)) as T[];
    },
    getFirstSync<T>(sql: string, params: SqlValue[]): T | null {
      return (db.prepare(sql).get(...bind(params)) as T | undefined) ?? null;
    },
    runSync(sql: string, params: SqlValue[]) {
      const r = db.prepare(sql).run(...bind(params));
      return {
        lastInsertRowId: Number(r.lastInsertRowid),
        changes: Number(r.changes),
      };
    },
    execSync(sql: string): void {
      db.exec(sql);
    },
    withTransactionSync(task: () => void): void {
      db.exec("BEGIN");
      try {
        task();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
