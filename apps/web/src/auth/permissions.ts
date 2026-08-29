/**
 * The role matrix, as one table.
 *
 * Read this next to `docs/sync-and-roles.md` and `arquitectura-api.md` §6.
 *
 * **This is not authorization.** The server decides, and it answers 403; the
 * only thing this file does is stop showing people doors they cannot open.
 * Hiding a button is not a permission — a phone gets handed around, and the
 * weigher role is given to whoever holds the scale for the season. Every
 * screen still has to survive a 403 arriving anyway, which is what
 * `useApiErrorHandler` is for.
 *
 * It is a table and not a pile of `if`s for the same reason the Go side keeps
 * one: with ten modules coming, a permission expressed as a condition inside a
 * component is a permission nobody can audit.
 */
import type { Role } from "../api/types";

export type Action =
  // Reading the farm at a glance. Shows money, so the weigher is out.
  | "dashboard.view"
  | "plots.read"
  | "plots.write"
  | "plots.delete"
  // The weigher gets a narrower projection of a worker: id, name, tag.
  | "workers.read"
  | "workers.readFull"
  | "workers.write"
  | "workers.delete"
  | "workers.profile"
  | "workers.notes"
  | "activities.read"
  | "activities.write"
  | "activities.setRate"
  | "workRecords.read"
  | "workRecords.readAll"
  | "workRecords.write"
  | "money.read"
  | "money.pay"
  | "config.farm"
  | "config.users"
  | "config.prices"
  | "admin.farms";

const OWNER: Action[] = [
  "dashboard.view",
  "plots.read", "plots.write", "plots.delete",
  "workers.read", "workers.readFull", "workers.write", "workers.delete",
  "workers.profile", "workers.notes",
  "activities.read", "activities.write", "activities.setRate",
  "workRecords.read", "workRecords.readAll", "workRecords.write",
  "money.read", "money.pay",
  "config.farm", "config.users", "config.prices",
];

/**
 * "Day-to-day running: register, settle, pay, correct. Cannot change prices or
 * remove people." Note that an administrator *can* pay: that is the whole
 * point of the role. What they cannot do is decide what work is worth.
 */
const ADMINISTRATOR: Action[] = [
  "dashboard.view",
  "plots.read", "plots.write",
  "workers.read", "workers.readFull", "workers.write",
  "workers.profile", "workers.notes",
  "activities.read", "activities.write",
  "workRecords.read", "workRecords.readAll", "workRecords.write",
  "money.read", "money.pay",
  "config.farm",
];

/**
 * The scale holder. Registers work and sees what they registered — nothing
 * about money, nothing about other people's figures.
 *
 * `workers.read` without `workers.readFull` is the narrow projection: enough
 * to pick a name from a list, without document number, phone or photo.
 */
const WEIGHER: Action[] = [
  "workers.read",
  "plots.read",
  "activities.read",
  "workRecords.read",
  "workRecords.write",
];

const MATRIX: Record<Role, ReadonlySet<Action>> = {
  owner: new Set(OWNER),
  administrator: new Set(ADMINISTRATOR),
  weigher: new Set(WEIGHER),
};

export interface Principal {
  role: Role;
  isSuperAdmin: boolean;
  /** A suspended farm can be read but not written to. */
  farmStatus?: "trial" | "active" | "suspended";
}

/** Actions that write. On a suspended farm every one of them is refused. */
const WRITE_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "plots.write", "plots.delete",
  "workers.write", "workers.delete", "workers.notes",
  "activities.write", "activities.setRate",
  "workRecords.write",
  "money.pay",
  "config.farm", "config.users", "config.prices",
]);

export function can(principal: Principal, action: Action): boolean {
  // The super-admin lives outside every tenant: it can list and suspend farms
  // and it can read nothing else. Not the ledger, not the workers, nothing.
  if (action === "admin.farms") return principal.isSuperAdmin;
  if (principal.isSuperAdmin) return false;

  if (principal.farmStatus === "suspended" && WRITE_ACTIONS.has(action)) return false;

  return MATRIX[principal.role]?.has(action) ?? false;
}

/** True when the farm is readable but frozen. Drives the read-only banner. */
export function isReadOnly(principal: Principal): boolean {
  return principal.farmStatus === "suspended";
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

export type Sprint = 1 | 2 | 3;

export interface ModuleDef {
  key: string;
  label: string;
  path: string;
  /** The action that has to be allowed for this entry to appear at all. */
  action: Action;
  /** Sprint 2 and 3 entries render disabled, so the map stays visible. */
  sprint: Sprint;
  icon: string;
}

/**
 * The sidebar of the wireframe in `docs/diagramas/web.md` §8.1, in order.
 *
 * The later-sprint modules are listed and disabled on purpose: the owner asked
 * for this map, and a sidebar that grows an entry every three weeks reads as an
 * unfinished product, while one that shows what is coming reads as a plan.
 */
export const MODULES: ModuleDef[] = [
  { key: "dashboard", label: "Tablero", path: "/tablero", action: "dashboard.view", sprint: 1, icon: "dashboard" },
  { key: "plots", label: "Parcelas", path: "/parcelas", action: "plots.read", sprint: 1, icon: "terrain" },
  { key: "workers", label: "Empleados", path: "/empleados", action: "workers.read", sprint: 1, icon: "people" },
  { key: "activities", label: "Actividades", path: "/actividades", action: "activities.read", sprint: 1, icon: "agriculture" },
  { key: "workRecords", label: "Labores", path: "/labores", action: "workRecords.read", sprint: 1, icon: "task" },
  { key: "settlements", label: "Liquidación", path: "/liquidaciones", action: "money.pay", sprint: 2, icon: "receipt" },
  { key: "sales", label: "Ventas", path: "/ventas", action: "money.read", sprint: 2, icon: "sell" },
  { key: "expenses", label: "Gastos", path: "/gastos", action: "money.read", sprint: 2, icon: "payments" },
  { key: "inventory", label: "Inventario", path: "/inventario", action: "money.read", sprint: 3, icon: "inventory" },
  { key: "config", label: "Configuración", path: "/configuracion", action: "config.farm", sprint: 1, icon: "settings" },
];

/** What this principal is allowed to see in the sidebar. */
export function visibleModules(principal: Principal): ModuleDef[] {
  if (principal.isSuperAdmin) return [];
  return MODULES.filter((m) => can(principal, m.action));
}

/**
 * Where to send someone right after they log in.
 *
 * The weigher has no dashboard — it is a money screen — so they land straight
 * on the only thing they came to do.
 */
export function landingPath(principal: Principal): string {
  if (principal.isSuperAdmin) return "/admin/fincas";
  // The weigher has no dashboard — it is a money screen — so they land on the
  // one thing they opened the app to do, not on the first module that happens
  // to be visible to them.
  if (principal.role === "weigher") return "/labores";
  const first = visibleModules(principal)[0];
  return first ? first.path : "/labores";
}
