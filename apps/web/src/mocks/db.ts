/**
 * A whole coffee farm, in memory.
 *
 * This exists because the API is being written in parallel and the web cannot
 * wait for it (plan-sprint-1.md §6, "La web bloqueada por la API"). It is not
 * a stub: the figures agree with the wireframes in `docs/diagramas/web.md` §8
 * to the peso, so that what the owner sees in the demo is what the document
 * promised. 38,5 kg x $800 = $30.800; the pending total is $153.600; the
 * derived balance is $184.500. If you change a seed number and those stop
 * matching, the seed is wrong, not the wireframe.
 *
 * Money is in integer cents throughout: $800 is 80000.
 *
 * The balance is never stored here either. It is summed from the ledger on
 * every read, the same discipline the server has, so a mock cannot teach the
 * UI a habit the real API will punish.
 */
import type {
  Activity,
  AdminFarm,
  CatalogItem,
  FarmSummary,
  LedgerEntry,
  MeUser,
  Plot,
  Role,
  WeekPrice,
  Worker,
  WorkRecord,
  WorkerNote,
} from "../api/types";

export const FARM_ID = "0192f3a0-0000-7000-8000-000000000001";

export const farm: FarmSummary = {
  id: FARM_ID,
  name: "La Esperanza",
  timezone: "America/Bogota",
  currency: "COP",
  status: "trial",
  trialDaysLeft: 12,
};

/* -- users ----------------------------------------------------------- */

export interface MockUser {
  id: string;
  email: string;
  password: string;
  name: string;
  role: Role;
  isSuperAdmin: boolean;
  emailVerified: boolean;
}

export const users: MockUser[] = [
  {
    id: "0192f3a0-0001-7000-8000-000000000001",
    email: "oscar@laesperanza.co",
    password: "esperanza",
    name: "Oscar Jaramillo",
    role: "owner",
    isSuperAdmin: false,
    emailVerified: true,
  },
  {
    id: "0192f3a0-0001-7000-8000-000000000002",
    email: "admin@laesperanza.co",
    password: "esperanza",
    name: "Gloria Betancur",
    role: "administrator",
    isSuperAdmin: false,
    emailVerified: true,
  },
  {
    id: "0192f3a0-0001-7000-8000-000000000003",
    email: "pesador@laesperanza.co",
    password: "esperanza",
    name: "Wilmar Grisales",
    role: "weigher",
    isSuperAdmin: false,
    emailVerified: true,
  },
  {
    id: "0192f3a0-0001-7000-8000-000000000009",
    email: "super@bascula.co",
    password: "bascula",
    name: "Soporte Báscula",
    role: "owner",
    isSuperAdmin: true,
    emailVerified: true,
  },
];

export function meFor(user: MockUser): MeUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isSuperAdmin: user.isSuperAdmin,
    farm,
    memberships: user.isSuperAdmin
      ? []
      : [{ farmId: FARM_ID, farmName: farm.name, role: user.role }],
  };
}

/* -- catalogs -------------------------------------------------------- */

export const cropTypes: CatalogItem[] = [
  { id: "0192f3a0-0002-7000-8000-000000000001", name: "Café" },
  { id: "0192f3a0-0002-7000-8000-000000000002", name: "Aguacate" },
  { id: "0192f3a0-0002-7000-8000-000000000003", name: "Plátano" },
  { id: "0192f3a0-0002-7000-8000-000000000004", name: "Yuca" },
];

export const varieties: CatalogItem[] = [
  { id: "0192f3a0-0003-7000-8000-000000000001", name: "Castillo", cropTypeId: cropTypes[0].id },
  { id: "0192f3a0-0003-7000-8000-000000000002", name: "Colombia", cropTypeId: cropTypes[0].id },
  { id: "0192f3a0-0003-7000-8000-000000000003", name: "Caturra", cropTypeId: cropTypes[0].id },
  { id: "0192f3a0-0003-7000-8000-000000000004", name: "Cenicafé 1", cropTypeId: cropTypes[0].id },
  { id: "0192f3a0-0003-7000-8000-000000000005", name: "Hass", cropTypeId: cropTypes[1].id },
  { id: "0192f3a0-0003-7000-8000-000000000006", name: "Lorena", cropTypeId: cropTypes[1].id },
  { id: "0192f3a0-0003-7000-8000-000000000007", name: "Dominico hartón", cropTypeId: cropTypes[2].id },
];

/* -- plots ----------------------------------------------------------- */

export const plots: Plot[] = [
  {
    id: "0192f3a0-0004-7000-8000-000000000001",
    name: "El Alto",
    department: "Caldas",
    municipality: "Manizales",
    areaHa: 4.2,
    computedAreaHa: null,
    boundary: null,
    status: "active",
    crops: [
      {
        id: "0192f3a0-0005-7000-8000-000000000001",
        cropTypeId: cropTypes[0].id, cropTypeName: "Café",
        varietyId: varieties[0].id, varietyName: "Castillo",
        areaHa: 2.6, plantedAt: "2022-04-15",
      },
      {
        id: "0192f3a0-0005-7000-8000-000000000002",
        cropTypeId: cropTypes[0].id, cropTypeName: "Café",
        varietyId: varieties[1].id, varietyName: "Colombia",
        areaHa: 1.6, plantedAt: "2023-09-02",
      },
    ],
  },
  {
    id: "0192f3a0-0004-7000-8000-000000000002",
    name: "La Cuchilla",
    department: "Caldas",
    municipality: "Manizales",
    areaHa: 2.75,
    computedAreaHa: null,
    boundary: null,
    status: "active",
    crops: [
      {
        id: "0192f3a0-0005-7000-8000-000000000003",
        cropTypeId: cropTypes[0].id, cropTypeName: "Café",
        varietyId: varieties[2].id, varietyName: "Caturra",
        areaHa: 2.75, plantedAt: "2019-03-10",
      },
    ],
  },
  {
    id: "0192f3a0-0004-7000-8000-000000000003",
    name: "Bajo del Río",
    department: "Caldas",
    municipality: "Chinchiná",
    areaHa: 6,
    // The only plot with a drawn polygon in the seed, so the "declared vs
    // computed" row of the wireframe has something to show before Sprint 2.
    computedAreaHa: 5.71,
    boundary: null,
    status: "active",
    crops: [
      {
        id: "0192f3a0-0005-7000-8000-000000000004",
        cropTypeId: cropTypes[1].id, cropTypeName: "Aguacate",
        varietyId: varieties[4].id, varietyName: "Hass",
        areaHa: 6, plantedAt: "2021-11-20",
      },
    ],
  },
  {
    id: "0192f3a0-0004-7000-8000-000000000004",
    name: "San José",
    department: "Caldas",
    municipality: "Chinchiná",
    areaHa: 1.5,
    computedAreaHa: null,
    boundary: null,
    status: "inactive",
    crops: [
      {
        id: "0192f3a0-0005-7000-8000-000000000005",
        cropTypeId: cropTypes[3].id, cropTypeName: "Yuca",
        varietyId: null, varietyName: null,
        areaHa: 1.5, plantedAt: null,
      },
    ],
  },
];

/* -- workers --------------------------------------------------------- */

export const workers: Worker[] = [
  {
    id: "0192f3a0-0006-7000-8000-000000000001",
    name: "María", lastName: "Restrepo Ospina",
    documentType: "CC", documentNumber: "1045882331",
    phone: "3205551212", address: "Vereda La Floresta", city: "Chinchiná",
    country: "Colombia", photoUrl: null, startedAt: "2025-03-12", status: "active",
  },
  {
    id: "0192f3a0-0006-7000-8000-000000000002",
    name: "Jhon Fredy", lastName: "Cardona Loaiza",
    documentType: "CC", documentNumber: "15322109",
    phone: "3117778899", address: "Barrio El Carmen", city: "Manizales",
    country: "Colombia", photoUrl: null, startedAt: "2024-08-01", status: "active",
  },
  {
    id: "0192f3a0-0006-7000-8000-000000000003",
    name: "Luz Dary", lastName: "Ospina Giraldo",
    documentType: "CC", documentNumber: "24556887",
    phone: "3009991010", address: "Vereda El Trébol", city: "Chinchiná",
    country: "Colombia", photoUrl: null, startedAt: "2026-01-15", status: "active",
  },
  {
    id: "0192f3a0-0006-7000-8000-000000000004",
    name: "Édinson", lastName: "Marín Ríos",
    documentType: "CE", documentNumber: "AV884219",
    phone: "3145557766", address: "Vereda La Floresta", city: "Chinchiná",
    country: "Colombia", photoUrl: null, startedAt: "2025-11-03", status: "active",
  },
  {
    id: "0192f3a0-0006-7000-8000-000000000005",
    name: "Nubia", lastName: "Ceballos Arango",
    documentType: "CC", documentNumber: "30112443",
    phone: "3186664545", address: "Corregimiento La Trinidad", city: "Chinchiná",
    country: "Colombia", photoUrl: null, startedAt: "2023-02-20", status: "inactive",
  },
];

/* -- activities ------------------------------------------------------ */

export const activities: Activity[] = [
  {
    id: "0192f3a0-0007-7000-8000-000000000001",
    name: "Recolección de café",
    category: "cosecha",
    payMode: "work_unit",
    workUnit: "kg",
    timeUnit: null, customQty: null, customPeriod: null,
    // The one activity whose price is not frozen on write: it takes the
    // Monday price of its week, at settlement time, like the phone does.
    rateSource: "weekly_price",
    defaultRateCents: 80000,
    status: "active",
  },
  {
    id: "0192f3a0-0007-7000-8000-000000000002",
    name: "Guadañada",
    category: "mantenimiento",
    payMode: "time_unit",
    workUnit: null,
    timeUnit: "jornal", customQty: null, customPeriod: null,
    rateSource: "fixed",
    defaultRateCents: 4500000, // $45.000 el jornal
    rates: [
      { validFrom: "2025-01-01", rateCents: 4000000 },
      { validFrom: "2026-01-01", rateCents: 4500000 },
    ],
    status: "active",
  },
  {
    id: "0192f3a0-0007-7000-8000-000000000003",
    name: "Fertilización",
    category: "mantenimiento",
    payMode: "time_unit",
    workUnit: null,
    timeUnit: "jornal", customQty: null, customPeriod: null,
    rateSource: "fixed",
    defaultRateCents: 5000000,
    rates: [{ validFrom: "2026-01-01", rateCents: 5000000 }],
    status: "active",
  },
  {
    id: "0192f3a0-0007-7000-8000-000000000004",
    name: "Siembra de colinos",
    category: "siembra",
    payMode: "contract",
    workUnit: null, timeUnit: null, customQty: null, customPeriod: null,
    rateSource: "fixed",
    defaultRateCents: 120000000, // $1.200.000 el contrato completo
    rates: [{ validFrom: "2026-02-01", rateCents: 120000000 }],
    status: "active",
  },
  {
    id: "0192f3a0-0007-7000-8000-000000000005",
    name: "Zoqueo",
    category: "mantenimiento",
    payMode: "contract",
    workUnit: null, timeUnit: null, customQty: null, customPeriod: null,
    rateSource: "fixed",
    defaultRateCents: 65000000,
    status: "inactive",
  },
  {
    id: "0192f3a0-0007-7000-8000-000000000006",
    name: "Recolección de aguacate",
    category: "cosecha",
    payMode: "work_unit",
    workUnit: "canasta",
    timeUnit: null, customQty: null, customPeriod: null,
    rateSource: "fixed",
    defaultRateCents: 350000, // $3.500 la canasta
    rates: [{ validFrom: "2026-01-01", rateCents: 350000 }],
    status: "active",
  },
];

/* -- weekly prices --------------------------------------------------- */

export const weekPrices: WeekPrice[] = [
  { monday: "2026-08-10", costPerUnitCents: 75000 },
  { monday: "2026-08-17", costPerUnitCents: 78000 },
  { monday: "2026-08-24", costPerUnitCents: 80000 },
];

/* -- work records ---------------------------------------------------- */

const A = activities;
const P = plots;

export const workRecords: WorkRecord[] = [
  {
    id: "0192f3a0-0008-7000-8000-000000000001",
    workerId: workers[0].id, workerName: "María Restrepo Ospina",
    activityId: A[0].id, activityName: A[0].name, category: "cosecha",
    payMode: "work_unit", unitLabel: "kg",
    plotIds: [P[0].id], plotNames: ["El Alto"],
    plotCropIds: [P[0].crops[0].id], plotCropNames: ["Café Castillo"],
    dateFrom: "2026-08-27", dateTo: "2026-08-27",
    quantity: 38.5, rateCents: null, estimatedAmountCents: 3080000,
    note: null, settled: false, status: "active",
  },
  {
    id: "0192f3a0-0008-7000-8000-000000000002",
    workerId: workers[0].id, workerName: "María Restrepo Ospina",
    activityId: A[0].id, activityName: A[0].name, category: "cosecha",
    payMode: "work_unit", unitLabel: "kg",
    plotIds: [P[0].id], plotNames: ["El Alto"],
    plotCropIds: [P[0].crops[0].id], plotCropNames: ["Café Castillo"],
    dateFrom: "2026-08-26", dateTo: "2026-08-26",
    quantity: 41, rateCents: null, estimatedAmountCents: 3280000,
    note: null, settled: false, status: "active",
  },
  {
    id: "0192f3a0-0008-7000-8000-000000000003",
    workerId: workers[0].id, workerName: "María Restrepo Ospina",
    activityId: A[1].id, activityName: A[1].name, category: "mantenimiento",
    payMode: "time_unit", unitLabel: "jornal",
    plotIds: [P[1].id], plotNames: ["La Cuchilla"],
    plotCropIds: [P[1].crops[0].id], plotCropNames: ["Café Caturra"],
    dateFrom: "2026-08-24", dateTo: "2026-08-25",
    quantity: 2, rateCents: 4500000, estimatedAmountCents: 9000000,
    note: "Guadañada del lote completo.", settled: false, status: "active",
  },
  {
    id: "0192f3a0-0008-7000-8000-000000000004",
    workerId: workers[1].id, workerName: "Jhon Fredy Cardona Loaiza",
    activityId: A[0].id, activityName: A[0].name, category: "cosecha",
    payMode: "work_unit", unitLabel: "kg",
    plotIds: [P[0].id], plotNames: ["El Alto"],
    plotCropIds: [P[0].crops[1].id], plotCropNames: ["Café Colombia"],
    dateFrom: "2026-08-27", dateTo: "2026-08-27",
    quantity: 52.3, rateCents: null, estimatedAmountCents: 4184000,
    note: null, settled: false, status: "active",
  },
  {
    id: "0192f3a0-0008-7000-8000-000000000005",
    workerId: workers[2].id, workerName: "Luz Dary Ospina Giraldo",
    activityId: A[5].id, activityName: A[5].name, category: "cosecha",
    payMode: "work_unit", unitLabel: "canasta",
    plotIds: [P[2].id], plotNames: ["Bajo del Río"],
    plotCropIds: [P[2].crops[0].id], plotCropNames: ["Aguacate Hass"],
    dateFrom: "2026-08-26", dateTo: "2026-08-26",
    quantity: 14, rateCents: 350000, estimatedAmountCents: 4900000,
    note: null, settled: false, status: "active",
  },
  {
    id: "0192f3a0-0008-7000-8000-000000000006",
    workerId: workers[3].id, workerName: "Édinson Marín Ríos",
    activityId: A[2].id, activityName: A[2].name, category: "mantenimiento",
    payMode: "time_unit", unitLabel: "jornal",
    plotIds: [P[1].id, P[2].id], plotNames: ["La Cuchilla", "Bajo del Río"],
    plotCropIds: [P[1].crops[0].id, P[2].crops[0].id],
    plotCropNames: ["Café Caturra", "Aguacate Hass"],
    dateFrom: "2026-08-20", dateTo: "2026-08-22",
    quantity: 3, rateCents: 5000000, estimatedAmountCents: 15000000,
    note: null, settled: true, status: "active",
  },
];

/* -- ledger ---------------------------------------------------------- */

/**
 * Signs follow BALANCE_SQL in the mobile schema: devengo positive; pago,
 * anticipo and deduccion negative; reverso carries the opposite sign of what
 * it cancels. The balance is SUM(amountCents) and nothing else.
 *
 * These six rows add up to $184.500, which is the figure in the wireframe.
 */
export const ledger: LedgerEntry[] = [
  {
    id: "0192f3a0-0009-7000-8000-000000000001", workerId: workers[0].id,
    kind: "devengo", concept: "Liquidación 11–16 ago", amountCents: 25300000,
    date: "2026-08-11", method: null, receiptNumber: null, reversesId: null,
  },
  {
    id: "0192f3a0-0009-7000-8000-000000000002", workerId: workers[0].id,
    kind: "reverso", concept: "Corrige pago #0038", amountCents: 1200000,
    date: "2026-08-18", method: null, receiptNumber: null,
    reversesId: "0192f3a0-0009-7000-8000-0000000000ff",
  },
  {
    id: "0192f3a0-0009-7000-8000-000000000003", workerId: workers[0].id,
    kind: "anticipo", concept: "Anticipo para transporte", amountCents: -5000000,
    date: "2026-08-19", method: "efectivo", receiptNumber: null, reversesId: null,
  },
  {
    id: "0192f3a0-0009-7000-8000-000000000004", workerId: workers[0].id,
    kind: "deduccion", concept: "Mercado adelantado", amountCents: -4500000,
    date: "2026-08-20", method: null, receiptNumber: null, reversesId: null,
  },
  {
    id: "0192f3a0-0009-7000-8000-000000000005", workerId: workers[0].id,
    kind: "devengo", concept: "Liquidación 18–23 ago", amountCents: 21450000,
    date: "2026-08-23", method: null, receiptNumber: null, reversesId: null,
  },
  {
    id: "0192f3a0-0009-7000-8000-000000000006", workerId: workers[0].id,
    kind: "pago", concept: "Efectivo · recibo #0041", amountCents: -20000000,
    date: "2026-08-23", method: "efectivo", receiptNumber: "0041", reversesId: null,
  },
  {
    id: "0192f3a0-0009-7000-8000-000000000007", workerId: workers[1].id,
    kind: "devengo", concept: "Liquidación 18–23 ago", amountCents: 18700000,
    date: "2026-08-23", method: null, receiptNumber: null, reversesId: null,
  },
  {
    id: "0192f3a0-0009-7000-8000-000000000008", workerId: workers[1].id,
    kind: "pago", concept: "Transferencia · recibo #0042", amountCents: -18700000,
    date: "2026-08-23", method: "transferencia", receiptNumber: "0042", reversesId: null,
  },
  {
    id: "0192f3a0-0009-7000-8000-000000000009", workerId: workers[3].id,
    kind: "devengo", concept: "Liquidación fertilización 20–22 ago",
    amountCents: 15000000,
    date: "2026-08-22", method: null, receiptNumber: null, reversesId: null,
  },
];

export const notes: Record<string, WorkerNote[]> = {
  [workers[0].id]: [
    {
      id: "0192f3a0-000a-7000-8000-000000000001",
      text: "Pidió adelanto para transporte. Autorizado.",
      date: "2026-08-21", authorName: "Gloria Betancur",
    },
    {
      id: "0192f3a0-000a-7000-8000-000000000002",
      text: "Excelente rendimiento en el lote El Alto.",
      date: "2026-07-03", authorName: "Oscar Jaramillo",
    },
  ],
};

/* -- super-admin ----------------------------------------------------- */

export const adminFarms: AdminFarm[] = [
  {
    id: FARM_ID, name: "La Esperanza", ownerEmail: "oscar@laesperanza.co",
    status: "trial", createdAt: "2026-08-17T14:02:00-05:00",
    lastAccessAt: "2026-08-29T07:41:00-05:00", workerCount: 5,
  },
  {
    id: "0192f3a0-0000-7000-8000-000000000002", name: "El Mirador",
    ownerEmail: "hcastano@elmirador.co", status: "active",
    createdAt: "2026-05-02T09:20:00-05:00",
    lastAccessAt: "2026-08-28T18:05:00-05:00", workerCount: 12,
  },
  {
    id: "0192f3a0-0000-7000-8000-000000000003", name: "Villa Nueva",
    ownerEmail: "adriana@villanueva.com.co", status: "active",
    createdAt: "2026-03-11T11:45:00-05:00",
    lastAccessAt: "2026-08-27T06:12:00-05:00", workerCount: 31,
  },
  {
    id: "0192f3a0-0000-7000-8000-000000000004", name: "La Palma",
    ownerEmail: "jm@lapalma.co", status: "suspended",
    createdAt: "2025-12-01T08:00:00-05:00",
    lastAccessAt: "2026-06-30T16:22:00-05:00", workerCount: 8,
  },
];

/** Sum the ledger. Never read a stored total; there isn't one on purpose. */
export function balanceOf(workerId: string) {
  const rows = ledger.filter((l) => l.workerId === workerId);
  const sum = (pred: (l: LedgerEntry) => boolean) =>
    rows.filter(pred).reduce((a, l) => a + l.amountCents, 0);
  return {
    workerId,
    earnedCents: sum((l) => l.kind === "devengo" || (l.kind === "reverso" && l.amountCents < 0)),
    paidCents: -sum(
      (l) => l.kind === "pago" || l.kind === "anticipo" || (l.kind === "reverso" && l.amountCents > 0),
    ),
    deductedCents: -sum((l) => l.kind === "deduccion"),
    balanceCents: rows.reduce((a, l) => a + l.amountCents, 0),
    lastMovementAt: rows.length ? rows[rows.length - 1].date : null,
  };
}

/** Work records nobody has settled yet: what the pay screen offers. */
export function pendingFor(workerId: string): WorkRecord[] {
  return workRecords.filter(
    (w) => w.workerId === workerId && !w.settled && w.status === "active",
  );
}

export function pendingCents(workerId: string): number {
  return pendingFor(workerId).reduce((a, w) => a + w.estimatedAmountCents, 0);
}
