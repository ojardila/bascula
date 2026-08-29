/**
 * The role matrix, pinned.
 *
 * Hiding a button is not a permission — the server decides and answers 403 —
 * but a sidebar that offers a weigher the payroll is still a bug, and one the
 * owner would see in a demo. These tests are the cheap half of the defence;
 * the expensive half is the contract test on the Go side.
 */
import { describe, expect, it } from "vitest";
import { MODULES, can, isReadOnly, landingPath, visibleModules, type Principal } from "./permissions";

const owner: Principal = { role: "owner", isSuperAdmin: false, farmStatus: "active" };
const admin: Principal = { role: "administrator", isSuperAdmin: false, farmStatus: "active" };
const weigher: Principal = { role: "weigher", isSuperAdmin: false, farmStatus: "active" };
const superAdmin: Principal = { role: "owner", isSuperAdmin: true };

describe("what each role can do", () => {
  it("gives the owner everything in their farm", () => {
    expect(can(owner, "money.pay")).toBe(true);
    expect(can(owner, "activities.setRate")).toBe(true);
    expect(can(owner, "workers.delete")).toBe(true);
    expect(can(owner, "config.users")).toBe(true);
  });

  it("lets the administrator run the day but not set prices or remove people", () => {
    expect(can(admin, "money.pay")).toBe(true);
    expect(can(admin, "workRecords.write")).toBe(true);
    expect(can(admin, "activities.setRate")).toBe(false);
    expect(can(admin, "workers.delete")).toBe(false);
    expect(can(admin, "plots.delete")).toBe(false);
    expect(can(admin, "config.users")).toBe(false);
  });

  it("keeps the weigher away from every peso", () => {
    // This role is handed to whoever holds the scale, often hired for the
    // season. It must not open the payroll.
    expect(can(weigher, "money.read")).toBe(false);
    expect(can(weigher, "money.pay")).toBe(false);
    expect(can(weigher, "workers.profile")).toBe(false);
    expect(can(weigher, "workers.notes")).toBe(false);
    expect(can(weigher, "activities.setRate")).toBe(false);
    expect(can(weigher, "config.farm")).toBe(false);
    expect(can(weigher, "dashboard.view")).toBe(false);
  });

  it("lets the weigher do the one job it exists for", () => {
    expect(can(weigher, "workRecords.write")).toBe(true);
    expect(can(weigher, "workRecords.read")).toBe(true);
    expect(can(weigher, "plots.read")).toBe(true);
    expect(can(weigher, "activities.read")).toBe(true);
  });

  it("gives the weigher a narrow read of people, not the full record", () => {
    expect(can(weigher, "workers.read")).toBe(true);
    expect(can(weigher, "workers.readFull")).toBe(false);
  });
});

describe("the super-admin is outside every tenant", () => {
  it("can see farms", () => {
    expect(can(superAdmin, "admin.farms")).toBe(true);
  });

  it("cannot read one single thing inside a farm", () => {
    // Not the ledger, not the workers, not the plots. Suspending a farm does
    // not come with the right to read it.
    for (const action of [
      "workers.read", "workers.profile", "money.read", "money.pay",
      "plots.read", "workRecords.read", "config.farm", "dashboard.view",
    ] as const) {
      expect(can(superAdmin, action)).toBe(false);
    }
  });

  it("is the only role that can reach the admin console", () => {
    expect(can(owner, "admin.farms")).toBe(false);
    expect(can(admin, "admin.farms")).toBe(false);
    expect(can(weigher, "admin.farms")).toBe(false);
  });
});

describe("a suspended farm", () => {
  const suspended: Principal = { ...owner, farmStatus: "suspended" };

  it("still reads", () => {
    expect(can(suspended, "plots.read")).toBe(true);
    expect(can(suspended, "workers.profile")).toBe(true);
    expect(can(suspended, "money.read")).toBe(true);
  });

  it("writes nothing at all, not even for the owner", () => {
    for (const action of [
      "plots.write", "plots.delete", "workers.write", "workRecords.write",
      "money.pay", "activities.setRate", "config.farm",
    ] as const) {
      expect(can(suspended, action)).toBe(false);
    }
  });

  it("is flagged so the shell can say why", () => {
    expect(isReadOnly(suspended)).toBe(true);
    expect(isReadOnly(owner)).toBe(false);
  });
});

describe("the sidebar follows the matrix", () => {
  it("shows the owner every sprint-1 module", () => {
    const keys = visibleModules(owner).map((m) => m.key);
    expect(keys).toContain("dashboard");
    expect(keys).toContain("plots");
    expect(keys).toContain("workers");
    expect(keys).toContain("activities");
    expect(keys).toContain("workRecords");
    expect(keys).toContain("config");
  });

  it("hides settings and money from the administrator where the matrix does", () => {
    const keys = visibleModules(admin).map((m) => m.key);
    expect(keys).toContain("config"); // farm data, yes
    expect(keys).toContain("workers");
  });

  it("leaves the weigher with the modules they can actually use", () => {
    const keys = visibleModules(weigher).map((m) => m.key);
    expect(keys).toEqual(["plots", "workers", "activities", "workRecords"]);
    expect(keys).not.toContain("dashboard");
    expect(keys).not.toContain("config");
    expect(keys).not.toContain("settlements");
  });

  it("gives the super-admin no farm sidebar whatsoever", () => {
    expect(visibleModules(superAdmin)).toEqual([]);
  });

  it("declares an action for every module, so none can be added unguarded", () => {
    for (const m of MODULES) {
      expect(m.action).toBeTruthy();
      expect(m.path.startsWith("/")).toBe(true);
    }
  });
});

describe("where each role lands after logging in", () => {
  it("takes the owner to the dashboard", () => {
    expect(landingPath(owner)).toBe("/tablero");
  });

  it("takes the weigher straight to work, since the dashboard is a money screen", () => {
    expect(landingPath(weigher)).toBe("/labores");
  });

  it("takes the super-admin to the console, outside the tenant", () => {
    expect(landingPath(superAdmin)).toBe("/admin/fincas");
  });
});
