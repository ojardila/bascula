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

  it("still operates a farm they belong to, with that farm's role", () => {
    // The flag opens the console. It does not blank the membership: Oscar
    // provisions farms and also runs San Jose.
    expect(can(superAdmin, "harvest.read")).toBe(true);
    expect(can(superAdmin, "money.pay")).toBe(true);
    expect(can(superAdmin, "workers.read")).toBe(true);
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
  it("shows the owner only the six day-to-day modules", () => {
    const keys = visibleModules(owner).map((m) => m.key);
    expect(keys).toEqual(["harvest", "plots", "workers", "payroll", "sales", "config"]);
    expect(visibleModules(owner).map((m) => m.label)).toEqual([
      "Cosecha",
      "Lotes",
      "Empleados",
      "Pagos",
      "Ventas",
      "Configuración",
    ]);
  });

  it("keeps farm settings for the administrator, without the owner's price screen in the short menu", () => {
    const keys = visibleModules(admin).map((m) => m.key);
    expect(keys).toContain("config");
    expect(keys).toContain("workers");
    expect(keys).toContain("harvest");
    expect(keys).not.toContain("weekPrice");
    expect(keys).not.toContain("dashboard");
  });

  it("leaves the weigher with lots, people, and Labores (their daily screen)", () => {
    const keys = visibleModules(weigher).map((m) => m.key);
    expect(keys).toEqual(["plots", "workers", "workRecords"]);
    expect(keys).not.toContain("dashboard");
    expect(keys).not.toContain("config");
    expect(keys).not.toContain("settlements");
    expect(keys).not.toContain("payroll");
  });

  it("gives the super-admin the farm sidebar of their membership, plus the console", () => {
    const keys = visibleModules(superAdmin).map((m) => m.key);
    expect(keys).toContain("harvest");
    expect(can(superAdmin, "admin.farms")).toBe(true);
  });

  it("declares an action for every module, so none can be added unguarded", () => {
    for (const m of MODULES) {
      expect(m.action).toBeTruthy();
      expect(m.path.startsWith("/")).toBe(true);
      expect(typeof m.inNav).toBe("boolean");
    }
  });
});

describe("where each role lands after logging in", () => {
  it("takes the owner to Cosecha", () => {
    expect(landingPath(owner)).toBe("/cosecha");
  });

  it("takes the weigher straight to Labores, since that is their job", () => {
    expect(landingPath(weigher)).toBe("/labores");
  });

  it("takes the super-admin to the console, outside the tenant", () => {
    expect(landingPath(superAdmin)).toBe("/admin/fincas");
  });
});
