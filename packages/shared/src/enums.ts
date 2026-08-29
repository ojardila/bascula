/**
 * The closed sets of the domain.
 *
 * These live here because the phone, the Go API and the web must agree on them
 * character for character. A value spelled `deduccion` on one side and
 * `deducción` on the other is a payment that silently stops being counted.
 *
 * Each set is declared once as a frozen tuple and the type is derived from it,
 * so the runtime list and the compile-time union can never drift apart. The
 * tuples are what a validator or a `<Picker>` iterates; the types are what the
 * compiler checks.
 *
 * Sources of truth, in this order:
 *   - what the phone already enforces  -> `apps/mobile/src/schema.ts` CHECKs
 *   - `docs/arquitectura-api.md`       -> the new server-side sets
 *   - `docs/modelo-datos.md`           -> the Postgres ENUM DDL
 */

/** Ledger movement kinds. `schema.ts` enforces exactly these in a CHECK. */
export const LEDGER_KINDS = [
  "devengo",
  "pago",
  "anticipo",
  "deduccion",
  "ajuste",
  "reverso",
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** How cash reached the worker. Free text would make the report unaddable. */
export const PAY_METHODS = ["efectivo", "transferencia", "otro"] as const;
export type PayMethod = (typeof PAY_METHODS)[number];

/**
 * Membership of a person in a farm — `farm_role` in `docs/modelo-datos.md`.
 * `superadmin` is deliberately NOT here: it is a flag on the user
 * (`users.is_superadmin`), not a role inside a farm, and it must never be
 * assignable through the same field that grants access to a farm's money.
 */
export const ROLES = ["owner", "admin", "weigher"] as const;
export type Role = (typeof ROLES)[number];

/**
 * A settlement is open or annulled; there is no third state and no way back
 * from `void` (see `docs/diagramas/movil.md` §7). A correction is a new
 * settlement, never an edit of the old one.
 */
export const SETTLEMENT_STATUSES = ["open", "void"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/**
 * How an activity is paid — `docs/arquitectura-api.md` §1.
 *   contract   a whole job for a price   (quantity = 1)
 *   time_unit  jornal / week / fortnight (quantity = number of time units)
 *   work_unit  kg / arroba / basket      (quantity = the weight or count)
 * A coffee pickup is `work_unit` with `unit = kg`; that is the only shape the
 * phone writes today.
 */
export const PAY_MODES = ["contract", "time_unit", "work_unit"] as const;
export type PayMode = (typeof PAY_MODES)[number];

/**
 * Activity families — and the one set here that is deliberately NOT closed.
 *
 * `arquitectura-api.md` lists three, `modelo-datos.md` declares four with
 * `otra`, and both are wrong: RSP-011 says the category picker comes "con
 * opcion de crear una nueva". A farm that grows cocoa alongside coffee will
 * invent categories nobody here thought of, and a closed set would make that
 * an `ALTER TYPE` in production every time.
 *
 * So the category is a per-farm catalogue row, not an enum, and what lives
 * here is only what a new farm starts with. Anything a farm adds afterwards is
 * as valid as these three.
 *
 * FOR THE BACKEND: `activity_category` must NOT be a Postgres ENUM. It is a
 * table with `farm_id`, seeded from this list, reached through
 * `GET|POST /v1/catalogs/activity-categories`.
 */
export const SEED_ACTIVITY_CATEGORIES = [
  "siembra",
  "mantenimiento",
  "cosecha",
] as const;

/** Narrowing helper: does an arbitrary string belong to one of the sets? */
export function isOneOf<T extends string>(
  set: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && (set as readonly string[]).includes(value);
}
