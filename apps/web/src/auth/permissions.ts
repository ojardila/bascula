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
import { EMPLEADO, LOTE } from "../lib/vocab";
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
  // Reading the harvest: the season curve, the week detail, the crop report,
  // the yield index and the weighing review. A read of everybody's figures at
  // once, so it sits with the money surface rather than with `workRecords.read`
  // — the weigher may see what HE registered, never the whole crew's.
  | "harvest.read"
  | "money.read"
  | "money.pay"
  // Products, the warehouse, sales and expenses. Four surfaces, eight actions,
  // and the weigher has none of them: `docs/modelo-datos.md` §790 puts
  // `ventas`, `gastos` and `stock_moves` outside his projection with the same
  // shape as the ledger, and the movements go with them because a movement
  // names what a lot produced.
  | "products.read"
  | "products.write"
  | "stock.read"
  | "stock.write"
  | "sales.read"
  | "sales.write"
  | "expenses.read"
  | "expenses.write"
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
  "harvest.read",
  "money.read", "money.pay",
  "products.read", "products.write",
  "stock.read", "stock.write",
  "sales.read", "sales.write",
  "expenses.read", "expenses.write",
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
  "harvest.read",
  "money.read", "money.pay",
  "products.read", "products.write",
  "stock.read", "stock.write",
  "sales.read", "sales.write",
  "expenses.read", "expenses.write",
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
  "products.write", "stock.write", "sales.write", "expenses.write",
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

export type Sprint = 1 | 2 | 3 | 4 | 5;

export interface ModuleDef {
  key: string;
  label: string;
  path: string;
  /** The action that has to be allowed for this entry to appear at all. */
  action: Action;
  /** Which sprint the module arrived (or arrives) in. Shown on the chip. */
  sprint: Sprint;
  /**
   * Whether THIS BUILD serves that path.
   *
   * Not `sprint <= CURRENT_SPRINT`, which is what this used to be in effect,
   * and which broke the moment sprint 3 landed three of these and not the
   * fourth: "Liquidación" is a sprint-2 idea that never became a route of its
   * own, because settling happens inside the payment screen. Deriving
   * availability from the number would have turned that entry into a live link
   * to a path the router does not have, and the router's catch-all would have
   * bounced whoever clicked it back to the dashboard with no explanation.
   */
  available: boolean;
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
  { key: "dashboard", label: "Tablero", path: "/tablero", action: "dashboard.view", sprint: 1, available: true, icon: "dashboard" },
  // Straight after the tablero, because it is the screen the owner opens every
  // morning during the season — not filed behind Labores, where the picking was
  // effectively hidden until Sprint 4.
  { key: "harvest", label: "Cosecha", path: "/cosecha", action: "harvest.read", sprint: 4, available: true, icon: "harvest" },
  // «Lotes», no «Parcelas»: el menú y el primer campo del formulario decían
  // cosas distintas de la misma tierra. `lib/vocab.ts` lo decide una sola vez.
  { key: "plots", label: LOTE.Many, path: LOTE.path, action: "plots.read", sprint: 1, available: true, icon: "terrain" },
  { key: "workers", label: EMPLEADO.Many, path: EMPLEADO.path, action: "workers.read", sprint: 1, available: true, icon: "people" },
  { key: "activities", label: "Actividades", path: "/actividades", action: "activities.read", sprint: 1, available: true, icon: "agriculture" },
  /**
   * EL PRECIO DEL KILO DE LA SEMANA, con su propia entrada.
   *
   * No estaba en ninguna parte: el `PUT` existía en el cliente y ninguna
   * pantalla lo llamaba. Quien lo buscaba terminaba en Actividades pulsando
   * «Precio fijo», que cambia la forma de pago de toda la recolección — otra
   * cosa, y sin aviso. Un campo escondido dentro de Configuración habría
   * dejado la misma trampa en pie; esto está donde se busca, junto a
   * Actividades, y se llama como lo llama el caficultor.
   *
   * `config.prices` es del dueño solo, igual que `prices.write` en el
   * servidor. Un administrador corre la finca y no decide cuánto vale el kilo.
   */
  { key: "weekPrice", label: "Precio del kilo", path: "/precio-semana", action: "config.prices", sprint: 5, available: true, icon: "price" },
  { key: "workRecords", label: "Labores", path: "/labores", action: "workRecords.read", sprint: 1, available: true, icon: "task" },
  // Sprint 5 gave settling a screen of its own. Making one still happens
  // inside "pagar empleado" — that is where the figure is approved — but the
  // settlements themselves are records now: which ones exist, whose, for which
  // week, and which are void. The action is `money.read` and not `money.pay`,
  // because looking at what was settled is a read.
  // La nómina de cuadrilla. `money.pay` and not `money.read`: this entry is a
  // door to a write, and `money.pay` is in WRITE_ACTIONS, so a suspended farm
  // does not get offered a payroll it would be refused. It sits above
  // Liquidaciones because it is the Saturday screen and the settlements list
  // is what you read afterwards.
  { key: "payroll", label: "Nómina", path: "/nomina", action: "money.pay", sprint: 5, available: true, icon: "payments" },
  { key: "settlements", label: "Liquidaciones", path: "/liquidaciones", action: "money.read", sprint: 2, available: true, icon: "receipt" },
  { key: "inventory", label: "Inventario", path: "/inventario", action: "products.read", sprint: 3, available: true, icon: "inventory" },
  { key: "sales", label: "Ventas", path: "/ventas", action: "sales.read", sprint: 3, available: true, icon: "sell" },
  { key: "expenses", label: "Gastos", path: "/gastos", action: "expenses.read", sprint: 3, available: true, icon: "payments" },
  { key: "config", label: "Configuración", path: "/configuracion", action: "config.farm", sprint: 1, available: true, icon: "settings" },
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
