/**
 * The thin wrappers of endpoints.ts that no screen test happens to reach:
 * each one is called against the same mock server the app uses, and has to
 * come back with a value or an ApiError, never a crash in the adapter.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { api } from "./endpoints";
import { setTokens } from "./client";
import { ApiError } from "./errors";
import { invalidateRefs } from "./refs";
import * as db from "../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const tenant = () => db.tenantOf(db.FARM_ID)!;

function signIn(userId: string) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
}

/** Resolves to the value, or to the ApiError the server answered with. */
async function answer<T>(call: () => Promise<T>): Promise<T | ApiError> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
}

beforeEach(() => {
  invalidateRefs();
  signIn(OWNER);
});

describe("endpoints that no screen test reaches", () => {
  it("plots: deactivate, reactivate and draw a boundary", async () => {
    const plot = await api.createPlot({
      name: "Lote para apagar",
      areaHa: 1,
    } as never);
    const off = await api.deactivatePlot(plot.id);
    expect(off.id).toBe(plot.id);
    const on = await api.reactivatePlot(plot.id);
    expect(on.id).toBe(plot.id);
    const square = {
      type: "Polygon",
      coordinates: [
        [
          [-75.6, 4.5],
          [-75.59, 4.5],
          [-75.59, 4.51],
          [-75.6, 4.51],
          [-75.6, 4.5],
        ],
      ],
    };
    const res = await answer(() => api.setPlotBoundary(plot.id, square));
    expect(res).toBeDefined();
  });

  it("workers: update, deactivate and read the notes", async () => {
    const w = tenant().workers[0];
    expect((await api.updateWorker(w.id, { name: "Nombre Nuevo" })).name).toBe(
      "Nombre Nuevo",
    );
    expect((await api.deactivateWorker(w.id)).id).toBe(w.id);
    expect(Array.isArray(await api.workerNotes(w.id))).toBe(true);
  });

  it("activities: create, update, deactivate, reactivate and set a rate", async () => {
    const created = await api.createActivity({
      id: crypto.randomUUID(),
      name: "Desyerbe de prueba",
      category: "mantenimiento",
      payMode: "time_unit",
      timeUnit: "jornal",
      rateSource: "fixed",
      defaultRateCents: 50000,
    });
    expect(created.name).toBe("Desyerbe de prueba");
    expect(
      (await api.updateActivity(created.id, { name: "Desyerbe" })).name,
    ).toBe("Desyerbe");
    expect((await api.deactivateActivity(created.id)).id).toBe(created.id);
    expect((await api.reactivateActivity(created.id)).id).toBe(created.id);
    await answer(() => api.setActivityRate(created.id, 55000, "2026-01-05"));
    // A work unit the farm does not have yet is created on the way.
    const byUnit = await api.createActivity({
      id: crypto.randomUUID(),
      name: "Por canecas",
      category: "cosecha",
      payMode: "work_unit",
      workUnit: "Caneca nueva",
      rateSource: "fixed",
      defaultRateCents: 1000,
    });
    expect(byUnit.name).toBe("Por canecas");
  });

  it("products, warehouses and catalogues", async () => {
    const made = await api.createProduct({
      id: crypto.randomUUID(),
      name: "Urea",
      storageUnit: "Bulto",
    });
    expect((await api.getProduct(made.id)).id).toBe(made.id);
    expect((await api.updateProduct(made.id, { name: "Urea 46" })).name).toBe(
      "Urea 46",
    );
    expect((await api.deactivateProduct(made.id)).id).toBe(made.id);
    expect((await api.reactivateProduct(made.id)).id).toBe(made.id);
    expect(await answer(() => api.createWarehouse("Bodega 2"))).toBeDefined();
    expect(
      await answer(() => api.createProductCategory("Abonos")),
    ).toBeDefined();
    expect(await answer(() => api.createStorageUnit("Bulto"))).toBeDefined();
    expect(await answer(() => api.createCustomer("Cooperativa"))).toBeDefined();
  });

  it("prices, tours and the farm", async () => {
    expect(
      await answer(() => api.setBasePrice("2026-01-05", 180000)),
    ).toBeDefined();
    expect(
      await answer(() =>
        api.deleteSpecialPrice("bonus" as never, "nope", "2026-01-05"),
      ),
    ).toBeDefined();
    expect(
      await answer(() => api.saveTour("weigher", 1, "in_progress" as never)),
    ).toBeDefined();
    expect(
      await answer(() => api.updateFarm({ name: "Finca Renombrada" })),
    ).toBeDefined();
  });

  it("money: an advance, a deduction and the settlement list", async () => {
    const w = tenant().workers[0];
    const adv = await answer(() =>
      api.createAdvance({
        id: crypto.randomUUID(),
        workerId: w.id,
        amountCents: 20000,
        method: "efectivo" as never,
      }),
    );
    expect(adv).toBeDefined();
    const ded = await answer(() =>
      api.createDeduction({
        id: crypto.randomUUID(),
        workerId: w.id,
        amountCents: 5000,
        concept: "Almuerzo",
        date: "2026-01-05",
      }),
    );
    expect(ded).toBeDefined();
    const list = await answer(() => api.listSettlements());
    expect(list).toBeDefined();
    const first = tenant().settlements[0];
    if (first)
      expect(await answer(() => api.getSettlement(first.id))).toBeDefined();
  });

  it("the rest of the small wrappers answer", async () => {
    const calls: Array<() => Promise<unknown>> = [
      () =>
        api.createWorkUnit({
          code: "bulto",
          label: "Bulto",
          kgFactor: 50,
        } as never),
      () => api.updateFarmUser(OWNER, { role: "admin" } as never),
      () => api.getLabelBatch("0192f3a0-0000-7000-8000-00000000dead"),
      () =>
        api.updateSale("0192f3a0-0000-7000-8000-00000000dead", { note: "x" }),
      () => api.reactivateWorkRecord(tenant().workRecords[0]?.id ?? "nope"),
      () => api.requestReadyEmail("san-jose"),
      () => api.verifyEmail("not-a-token"),
      () => api.adminSetFarmStatus(db.FARM_ID, "active" as never),
    ];
    const expense = tenant().expenses[0];
    if (expense) {
      calls.push(
        () => api.deactivateExpense(expense.id),
        () => api.reactivateExpense(expense.id),
      );
    }
    for (const call of calls) expect(await answer(call)).toBeDefined();
  });

  it("logs out", async () => {
    await api.logout();
  });
});
