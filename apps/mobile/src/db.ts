/**
 * The phone's data layer, wired up.
 *
 * This file used to be 1,500 lines that opened `bascula.db` at module scope.
 * That single line meant nothing here could be imported outside a phone, so
 * settle, pay, void, undo and every migration shipped without a test
 * (`docs/diagramas/movil.md` §9.2). All of that logic now lives in
 * `data/sqliteRepository.ts`, which is handed a connection instead of opening
 * one; what is left here is the wiring, and the screens' imports are unchanged.
 *
 * The named exports below are the same objects the screens have always
 * imported. They are now views onto a `Repository`, so the day there is a
 * server the second implementation goes behind this same line and no screen
 * has to know.
 */

import * as SQLite from "expo-sqlite";

// The domain rules the server has to agree with, character for character.
// They live in packages/shared so a divergence is impossible rather than
// merely unlikely.
import { toCents, fromCents } from "../../../packages/shared/src/money.ts";
import { localDayOf } from "../../../packages/shared/src/time.ts";

import { createSqliteRepository } from "./data/sqliteRepository.ts";
import type { Repository } from "./data/repository.ts";

export { toCents, fromCents };
export { ConfirmationRequired } from "./data/sqliteRepository.ts";
export type { Repository } from "./data/repository.ts";
export type { SqlDatabase } from "./data/sqliteRepository.ts";

export type {
  AppLang,
  Anomaly,
  Balance,
  BalanceRow,
  CostOverride,
  Crop,
  CropConfig,
  Grouping,
  LedgerEntry,
  LedgerKind,
  PayMethod,
  PendingItem,
  Person,
  Pickup,
  Settlement,
  SettlementItem,
  SettlementPreview,
  SettlementStatus,
  WorkerPerf,
} from "./data/repository.ts";

/**
 * The one connection. The whole point of the layer below is that this is the
 * only line in the app that knows it is SQLite.
 */
export const repository: Repository = createSqliteRepository(
  SQLite.openDatabaseSync("bascula.db"),
);

/** Local calendar day, not the UTC one. See `packages/shared/src/time.ts`. */
export const today = () => localDayOf();

export const initDb = () => repository.init();

export const People = repository.people;
export const Crops = repository.crops;
export const Pickups = repository.pickups;
export const Reports = repository.reports;
export const WorkerReports = repository.workerReports;
export const CropReports = repository.cropReports;
export const WeekReports = repository.weekReports;
export const Config = repository.config;
export const Prefs = repository.prefs;
export const Overrides = repository.overrides;
export const Demo = repository.demo;
export const Payments = repository.payments;
export const Performance = repository.performance;
export const Anomalies = repository.anomalies;
export const Export = repository.export;

export const weekCrops = repository.weekCrops;
export const reportBy = repository.reportBy;
export const costForWeek = repository.costForWeek;
export const totalPayout = repository.totalPayout;
