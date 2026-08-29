/**
 * @bascula/shared — what must not diverge.
 *
 * The rule for this package (`docs/arquitectura-api.md` §7): only what costs
 * money if the phone, the Go API and the web disagree. Closed sets of values,
 * the money arithmetic, and the derivation of a week and a day. Everything
 * else stays where it is used.
 *
 * Deliberately NOT here: the database. `apps/mobile/src/db.ts` is expo-sqlite
 * and `schema.ts` is SQLite dialect — the server has Postgres. What crosses
 * over is the SQL's *behaviour*, pinned by the golden cases in `./golden`, not
 * the SQL itself.
 */

export * from "./enums.ts";
export * from "./money.ts";
export * from "./time.ts";
// Named rather than starred: format.ts re-exports the time helpers for its own
// callers, and a second star of the same names would be ambiguous here.
export {
  type Lang,
  formatMoney,
  formatNumber,
  formatWeekRange,
  formatDay,
} from "./format.ts";
export * from "./harvest.ts";
