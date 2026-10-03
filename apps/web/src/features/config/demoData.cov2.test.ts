// SPDX-License-Identifier: MIT
/**
 * Demo data on a farm that has no people yet but already has the coffee crop
 * and its lotes: it reuses both instead of creating new ones.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/endpoints";
import { invalidateRefs } from "../../api/refs";
import * as db from "../../mocks/db";
import { signInOwner } from "../../test/renderWithAuth";
import { loadDemoData } from "./demoData";
import { uuidv7 } from "../../lib/uuid";

beforeEach(() => {
  signInOwner();
  db.tenants.set(db.FARM_ID, db.emptyTenant(db.FARM_ID, 1_000_00, () => crypto.randomUUID()));
  invalidateRefs();
});

describe("loadDemoData on a farm with crops and lotes", () => {
  it("keeps the farm's own Café and lotes", async () => {
    const cafe = await api.createCropType("Café");
    await api.createPlot({
      id: uuidv7(),
      name: "La Loma",
      department: "Caldas",
      municipality: "Chinchiná",
      areaHa: 3,
      crops: [{ id: uuidv7(), cropTypeId: cafe.id, varietyId: null, areaHa: 3, plantedAt: null }],
    });
    const create = vi.spyOn(api, "createCropType");
    const r = await loadDemoData("2026-09-25");
    expect(create).not.toHaveBeenCalled();
    expect(r.workers).toBe(6);
    const plots = await api.listPlots({ status: "active" });
    expect(plots.map((p) => p.name)).toEqual(["La Loma"]);
    expect((await api.cropTypes()).filter((c) => /caf[eé]/i.test(c.name))).toHaveLength(1);
  }, 60_000);

  it("creates the harvest activity when the farm has none", async () => {
    db.tenantOf(db.FARM_ID)!.activities = [];
    const r = await loadDemoData("2026-09-25");
    expect(r.weighings).toBeGreaterThan(100);
    const names = (await api.listActivities({ status: "active" })).map((a) => a.name);
    expect(names).toContain("Recolección");
  }, 60_000);
});
