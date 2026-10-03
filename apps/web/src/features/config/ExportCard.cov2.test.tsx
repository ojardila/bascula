// SPDX-License-Identifier: MIT
/**
 * The CSV exports with data the tables do not name: a movement kind or a
 * payment method with no Spanish label, a balance for somebody no longer in
 * the list, a weighing whose value is neither fixed nor provisional, and a
 * session whose farm has no address (the file is still named).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { ExportCard, balancesCsv, movementsCsv, weighingsCsv } from "./ExportCard";
import { api } from "../../api/endpoints";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";
import * as csv from "../../lib/csv";
import { OWNER, signInOwner } from "../../test/renderWithAuth";

const lines = (text: string) => text.replace(/^\uFEFF/, "").trim().split("\r\n");

beforeEach(() => {
  signInOwner();
  invalidateRefs();
});
afterEach(() => vi.restoreAllMocks());

describe("the CSV builders, with words the tables do not know", () => {
  it("keeps an unknown movement kind and payment method as they came", async () => {
    const [w] = await api.listWorkers({ status: "all" });
    vi.spyOn(api, "listWorkers").mockResolvedValue([w]);
    vi.spyOn(api, "workerLedger").mockResolvedValue([
      { date: "2026-09-01", kind: "bono", concept: "Bono", amountCents: 1_000_00, method: "cheque" },
      { date: "2026-09-02", kind: "bono", concept: "Sin medio", amountCents: 2_000_00, method: null },
    ] as never);
    const rows = lines(await movementsCsv());
    expect(rows[1]).toContain(";bono;Bono;");
    expect(rows[1]).toMatch(/;cheque$/);
    expect(rows[2]).toMatch(/;$/);
  });

  it("writes a dash for a balance of somebody who is not in the list", async () => {
    vi.spyOn(api, "listWorkers").mockResolvedValue([]);
    vi.spyOn(api, "listBalances").mockResolvedValue([
      {
        workerId: "nadie",
        earnedCents: 0,
        paidCents: 0,
        deductedCents: 0,
        balanceCents: 0,
        lastMovementOn: null,
      },
    ] as never);
    const rows = lines(await balancesCsv());
    expect(rows[1]).toMatch(/^—;/);
  });

  it("leaves the «Precio del valor» cell empty when it is not known", async () => {
    const [r] = await api.listWorkRecords({ status: "active" });
    vi.spyOn(api, "listWorkRecords").mockResolvedValue([
      { ...r, unitLabel: "kg", amountIsEstimate: null },
    ]);
    const rows = lines(await weighingsCsv());
    expect(rows[1]).toMatch(/;$/);
  });
});

describe("ExportCard, on a session whose farm has no address", () => {
  it("names the file after «finca»", async () => {
    server.use(
      http.get("*/v1/me", () =>
        HttpResponse.json({
          id: OWNER,
          email: "oscar@laesperanza.co",
          name: "Oscar Jaramillo",
          role: "owner",
          farm: { id: db.FARM_ID, name: "La Esperanza", timezone: "America/Bogota", currency: "COP" },
          superadmin: false,
        }),
      ),
    );
    vi.spyOn(csv, "downloadCsv").mockReturnValue(true);
    const user = userEvent.setup();
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <AuthProvider>
            <ExportCard />
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Saldos por empleado" }));
    expect(await screen.findByText(/Se descargó bascula-finca-saldos-/)).toBeInTheDocument();
  }, 20000);
});
