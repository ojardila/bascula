/**
 * THE HAND-WRITTEN WIRE TYPES, CHECKED AGAINST THE CONTRACT AT COMPILE TIME.
 *
 * This file has no runtime. It exists so that `npm run build` fails the day
 * `wire.ts` and `services/api/openapi.yaml` stop agreeing — which was the
 * declared debt at the top of `types.ts`: "openapi.yaml still does not exist;
 * when it lands, wire.ts is what gets replaced by the generated module."
 *
 * IT DID NOT GET REPLACED, AND THAT IS THE DECISION HERE.
 *
 * `schema.ts` is generated from the spec by `npm run types:api` and is 6 500
 * lines of `components["schemas"]["Sale"]["properties"]`-shaped indirection.
 * Reading a screen's data flow through it is materially worse than reading
 * `wire.ts`, and every "why is this null" comment in `wire.ts` — the ones that
 * cost an afternoon each to learn — has nowhere to live in a generated file.
 * Deleting them to save a transcription would trade a real thing for a tidy
 * one.
 *
 * So both exist and the generated one is the JUDGE, not the source:
 *
 *   schema.ts          generated, never edited, checked for freshness by
 *                      `scripts/check-openapi-types.mjs` on every build
 *   wire.ts            hand-written, commented, what the app actually imports
 *   this file          asserts the two describe the same bytes
 *
 * WHAT IS ASSERTED, and why it is these two things and not one `Equal<>`.
 *
 *   SAME KEYS   `Exclude<keyof A, keyof B>` must be `never`, in both
 *               directions. This is what catches a renamed field, a field the
 *               server added, and a field we invented — the three ways a
 *               transcription actually rots.
 *
 *   ASSIGNABLE  `Ours extends Spec`. This catches a field whose TYPE drifted:
 *               a number that became a string, an enum that grew a member.
 *
 * The reverse assignability (`Spec extends Ours`) is deliberately NOT
 * asserted. openapi-typescript makes every property absent from a schema's
 * `required` list optional, and Go's `encoding/json` emits every field of a
 * struct unless it is tagged `omitempty` — so `deletedAt?: string | null` in
 * the spec and `deletedAt: string | null` here describe the same JSON, and
 * asserting mutual assignability would flag several dozen of those and teach
 * everybody to ignore this file.
 */
import type { components } from "./schema";
import type {
  WireActivity, WireActivityRate, WireAdminFarm, WireBalance, WireBoundaryResult,
  WireCatalogItem, WireCustomer, WireExpense, WireLabelBatch, WireLedgerEntry,
  WireNote, WirePlot, WirePlotCrop, WireProduct, WireSale, WireStockLevel,
  WireStockMove, WireWeekPrice, WireWorkUnit,
  WireAnomaly, WireHarvestCurve, WireHarvestShape, WireHarvestWeekTotal,
  WireReportAnomaliesResult, WireReportCrop, WireReportGrid, WireReportGridCell,
  WireReportGridColumn, WireReportGridRow, WireReportPerformanceResult,
  WireReportTotals, WireReportUnattributed, WireReportWeek, WireReportWeekDetail,
  WireReportWeeksResult, WireWorkerPerformance,
} from "./wire";

type Schemas = components["schemas"];

/**
 * The failure NAMES THE FIELD. `SameKeys` resolves to `true` when the two key
 * sets match and to a labelled tuple when they do not, and `Check` refuses
 * anything but `true` — so a drifted field arrives as
 *
 *     Type '["sobra en wire.ts:", "warehouse"]' does not satisfy 'true'
 *
 * which says both what happened and which field it was. That is why this is a
 * type and not a runtime test: a runtime test could only compare the two at
 * the moment somebody remembered to run it.
 */
type Check<T extends true> = T;

/** `Ours` has to be usable wherever the contract's shape is expected. */
type Assignable<Ours extends Spec, Spec> = [Ours, Spec];

type SameKeys<Ours, Spec> = [Exclude<keyof Ours, keyof Spec>] extends [never]
  ? [Exclude<keyof Spec, keyof Ours>] extends [never]
    ? true
    : ["falta en wire.ts:", Exclude<keyof Spec, keyof Ours>]
  : ["sobra en wire.ts:", Exclude<keyof Ours, keyof Spec>];

/* -- plots ---------------------------------------------------------- */

/**
 * `boundary` is the one field deliberately WIDER here than in the contract.
 * `wire.ts` types it `unknown` because nothing on the wire is verified, and
 * `lib/geo.ts#asGeometry` is the single door in — so the map draws nothing
 * rather than drawing `undefined`. Narrowing it to the spec's shape would be
 * asserting something no code checked, so the key is compared and the type is
 * not.
 */
type _Plot = [
  Check<SameKeys<WirePlot, Schemas["Plot"]>>,
  Assignable<Omit<WirePlot, "boundary">, Omit<Schemas["Plot"], "boundary">>,
];
type _PlotCrop = [
  Check<SameKeys<WirePlotCrop, Schemas["PlotCrop"]>>,
  Assignable<WirePlotCrop, Schemas["PlotCrop"]>,
];
type _Boundary = [
  Check<SameKeys<WireBoundaryResult, Schemas["BoundaryResult"]>>,
  Assignable<WireBoundaryResult["overlaps"], Schemas["BoundaryResult"]["overlaps"]>,
];

/* -- catalogues and activities -------------------------------------- */

type _CatalogItem = [
  Check<SameKeys<WireCatalogItem, Schemas["CatalogItem"]>>,
  Assignable<WireCatalogItem, Schemas["CatalogItem"]>,
];
type _WorkUnit = [
  Check<SameKeys<WireWorkUnit, Schemas["WorkUnit"]>>,
  Assignable<WireWorkUnit, Schemas["WorkUnit"]>,
];
type _ActivityRate = [
  Check<SameKeys<WireActivityRate, Schemas["ActivityRate"]>>,
  Assignable<WireActivityRate, Schemas["ActivityRate"]>,
];
type _Activity = [
  Check<SameKeys<WireActivity, Schemas["Activity"]>>,
  Assignable<WireActivity, Schemas["Activity"]>,
];

/* -- money ---------------------------------------------------------- */

type _Balance = [
  Check<SameKeys<WireBalance, Schemas["Balance"]>>,
  Assignable<WireBalance, Schemas["Balance"]>,
];
type _LedgerEntry = [
  Check<SameKeys<WireLedgerEntry, Schemas["LedgerEntry"]>>,
  Assignable<WireLedgerEntry, Schemas["LedgerEntry"]>,
];
type _WeekPrice = [
  Check<SameKeys<WireWeekPrice, Schemas["WeekPrice"]>>,
  Assignable<WireWeekPrice, Schemas["WeekPrice"]>,
];

/* -- workers and the platform console -------------------------------- */

type _Note = [Check<SameKeys<WireNote, Schemas["Note"]>>, Assignable<WireNote, Schemas["Note"]>];
type _AdminFarm = [
  Check<SameKeys<WireAdminFarm, Schemas["AdminFarm"]>>,
  Assignable<WireAdminFarm, Schemas["AdminFarm"]>,
];

/* -- products, inventory, sales and expenses ------------------------- */

type _Product = [
  Check<SameKeys<WireProduct, Schemas["Product"]>>,
  Assignable<WireProduct, Schemas["Product"]>,
];
type _Customer = [
  Check<SameKeys<WireCustomer, Schemas["Customer"]>>,
  Assignable<WireCustomer, Schemas["Customer"]>,
];
type _StockLevel = [
  Check<SameKeys<WireStockLevel, Schemas["StockLevel"]>>,
  Assignable<WireStockLevel, Schemas["StockLevel"]>,
];
type _StockMove = [
  Check<SameKeys<WireStockMove, Schemas["StockMove"]>>,
  Assignable<WireStockMove, Schemas["StockMove"]>,
];
type _LabelBatch = [
  Check<SameKeys<WireLabelBatch, Schemas["LabelBatch"]>>,
  Assignable<WireLabelBatch, Schemas["LabelBatch"]>,
];
type _Sale = [Check<SameKeys<WireSale, Schemas["Sale"]>>, Assignable<WireSale, Schemas["Sale"]>];
type _Expense = [
  Check<SameKeys<WireExpense, Schemas["Expense"]>>,
  Assignable<WireExpense, Schemas["Expense"]>,
];

/**
 * `noUnusedLocals` would otherwise delete this whole file's point, so the
 * assertions are collected into one exported type. Nothing imports it; the
 * checking happened above, at the moment each alias was instantiated.
 */
/* -- reports (cosecha) ---------------------------------------------- */

/**
 * These six are the ones worth asserting hardest. Every nullable field in
 * `ReportTotals` exists to stop a zero being printed where nothing is known,
 * and a transcription that quietly widened one of them back to `number` would
 * reintroduce exactly the bug the contract was shaped to prevent — with the
 * screens still compiling.
 */
type _ReportTotals = [
  Check<SameKeys<WireReportTotals, Schemas["ReportTotals"]>>,
  Assignable<WireReportTotals, Schemas["ReportTotals"]>,
];
type _ReportWeek = [
  Check<SameKeys<WireReportWeek, Schemas["ReportWeek"]>>,
  Assignable<WireReportWeek, Schemas["ReportWeek"]>,
];
type _ReportWeeksResult = [
  Check<SameKeys<WireReportWeeksResult, Schemas["ReportWeeksResult"]>>,
  Assignable<WireReportWeeksResult, Schemas["ReportWeeksResult"]>,
];
type _ReportGridCell = [
  Check<SameKeys<WireReportGridCell, Schemas["ReportGridCell"]>>,
  Assignable<WireReportGridCell, Schemas["ReportGridCell"]>,
];
type _ReportGridRow = [
  Check<SameKeys<WireReportGridRow, Schemas["ReportGridRow"]>>,
  Assignable<WireReportGridRow, Schemas["ReportGridRow"]>,
];
type _ReportGridColumn = [
  Check<SameKeys<WireReportGridColumn, Schemas["ReportGridColumn"]>>,
  Assignable<WireReportGridColumn, Schemas["ReportGridColumn"]>,
];
type _ReportUnattributed = [
  Check<SameKeys<WireReportUnattributed, Schemas["ReportUnattributed"]>>,
  Assignable<WireReportUnattributed, Schemas["ReportUnattributed"]>,
];
type _ReportGrid = [
  Check<SameKeys<WireReportGrid, Schemas["ReportGrid"]>>,
  Assignable<WireReportGrid, Schemas["ReportGrid"]>,
];
type _ReportWeekDetail = [
  Check<SameKeys<WireReportWeekDetail, Schemas["ReportWeekDetail"]>>,
  Assignable<WireReportWeekDetail, Schemas["ReportWeekDetail"]>,
];
type _ReportCrop = [
  Check<SameKeys<WireReportCrop, Schemas["ReportCrop"]>>,
  Assignable<WireReportCrop, Schemas["ReportCrop"]>,
];
type _WorkerPerformance = [
  Check<SameKeys<WireWorkerPerformance, Schemas["WorkerPerformance"]>>,
  Assignable<WireWorkerPerformance, Schemas["WorkerPerformance"]>,
];
type _ReportPerformanceResult = [
  Check<SameKeys<WireReportPerformanceResult, Schemas["ReportPerformanceResult"]>>,
  Assignable<WireReportPerformanceResult, Schemas["ReportPerformanceResult"]>,
];
type _Anomaly = [
  Check<SameKeys<WireAnomaly, Schemas["Anomaly"]>>,
  Assignable<WireAnomaly, Schemas["Anomaly"]>,
];
type _ReportAnomaliesResult = [
  Check<SameKeys<WireReportAnomaliesResult, Schemas["ReportAnomaliesResult"]>>,
  Assignable<WireReportAnomaliesResult, Schemas["ReportAnomaliesResult"]>,
];
type _HarvestWeekTotal = [
  Check<SameKeys<WireHarvestWeekTotal, Schemas["HarvestWeekTotal"]>>,
  Assignable<WireHarvestWeekTotal, Schemas["HarvestWeekTotal"]>,
];
type _HarvestShape = [
  Check<SameKeys<WireHarvestShape, Schemas["HarvestShape"]>>,
  Assignable<WireHarvestShape, Schemas["HarvestShape"]>,
];
type _HarvestCurve = [
  Check<SameKeys<WireHarvestCurve, Schemas["HarvestCurve"]>>,
  Assignable<WireHarvestCurve, Schemas["HarvestCurve"]>,
];

export type ContractAssertions = [
  _Plot, _PlotCrop, _Boundary,
  _CatalogItem, _WorkUnit, _ActivityRate, _Activity,
  _Balance, _LedgerEntry, _WeekPrice,
  _Note, _AdminFarm,
  _Product, _Customer, _StockLevel, _StockMove, _LabelBatch, _Sale, _Expense,
  _ReportTotals, _ReportWeek, _ReportWeeksResult,
  _ReportGridCell, _ReportGridRow, _ReportGridColumn, _ReportUnattributed,
  _ReportGrid, _ReportWeekDetail, _ReportCrop,
  _WorkerPerformance, _ReportPerformanceResult,
  _Anomaly, _ReportAnomaliesResult,
  _HarvestWeekTotal, _HarvestShape, _HarvestCurve,
];
