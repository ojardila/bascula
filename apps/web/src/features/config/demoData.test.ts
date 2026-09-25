import { beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api/endpoints";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import * as db from "../../mocks/db";
import { DEMO_NOTE, FarmNotEmptyError, loadDemoData } from "./demoData";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

describe("demo data", () => {
  it("refuses to touch a farm that already has people or work", async () => {
    await expect(loadDemoData("2026-09-25")).rejects.toBeInstanceOf(FarmNotEmptyError);
  });

  it("fills an empty farm with six people and four weeks of weighings", async () => {
    db.tenants.set(db.FARM_ID, db.emptyTenant(db.FARM_ID, 1_000_00, () => crypto.randomUUID()));
    invalidateRefs();
    const seen: number[] = [];
    const r = await loadDemoData("2026-09-25", (p) => seen.push(p.done));
    expect(r.workers).toBe(6);
    expect(r.weighings).toBeGreaterThan(100);
    expect(seen.at(-1)).toBe(r.weighings);

    expect(await api.listWorkers({ status: "active" })).toHaveLength(6);
    const plots = await api.listPlots({ status: "active" });
    expect(plots.map((p) => p.name)).toEqual(expect.arrayContaining(["El Alto", "La Cañada"]));
    const records = await api.listWorkRecords({ status: "active" });
    expect(records).toHaveLength(r.weighings);
    expect(records.every((w) => w.dateFrom <= "2026-09-25" && w.dateFrom >= "2026-08-31")).toBe(true);
    expect(records[0]).toMatchObject({ unitLabel: expect.any(String) });
    void DEMO_NOTE;
  }, 60_000);
});
