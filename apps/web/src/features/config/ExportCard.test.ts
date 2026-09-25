import { beforeEach, describe, expect, it } from "vitest";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import * as db from "../../mocks/db";
import { balancesCsv, movementsCsv, weighingsCsv } from "./ExportCard";

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

const lines = (csv: string) => csv.replace(/^\uFEFF/, "").trim().split("\r\n");

describe("the farm's data as CSV", () => {
  it("lists the weighings, one per row", async () => {
    const rows = lines(await weighingsCsv());
    expect(rows[0]).toBe("Fecha;Empleado;Actividad;Lotes;Cantidad;Unidad;Precio;Valor;Precio del valor");
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[1]).toMatch(/^\d{4}-\d{2}-\d{2};/);
  });

  it("lists every money movement with its kind in farm words", async () => {
    const rows = lines(await movementsCsv());
    expect(rows[0]).toBe("Fecha;Empleado;Movimiento;Concepto;Valor;Medio de pago");
    for (const r of rows.slice(1)) expect(r).not.toMatch(/;(devengo|deduccion|reverso);/);
  });

  it("lists a balance per person", async () => {
    const rows = lines(await balancesCsv());
    expect(rows[0]).toBe("Empleado;Ganado;Pagado;Descontado;Saldo;Último movimiento");
    expect(rows.length).toBeGreaterThan(1);
  });
});
