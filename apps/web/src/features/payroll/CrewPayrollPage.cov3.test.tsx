// SPDX-License-Identifier: MIT
/**
 * The head count under the crew payroll's totals, for a team the server
 * lists with no member list at all: that account is still one person, not
 * zero, and not left out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { CrewPayrollPage } from "./CrewPayrollPage";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { api } from "../../api/endpoints";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { signInOwner } from "../../test/renderWithAuth";

const MARIA = "0192f3a0-0006-7000-8000-000000000001";
const JHON = "0192f3a0-0006-7000-8000-000000000002";

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  signInOwner();
});
afterEach(() => vi.restoreAllMocks());

describe("CrewPayrollPage head count", () => {
  it("counts a team with no member list as one person", async () => {
    const t = db.tenantOf(db.FARM_ID)!;
    const maria = t.workers.find((w) => w.id === MARIA)!;
    maria.kind = "equipo";
    maria.members = [
      { id: "m-c3w-1", name: "Ana", lastName: "Uno", tag: null, from: "2026-01-01", to: null },
      { id: "m-c3w-2", name: "Beto", lastName: "Dos", tag: null, from: "2026-01-01", to: null },
      { id: "m-c3w-3", name: "Ciro", lastName: "Tres", tag: null, from: "2026-01-01", to: null },
    ];
    t.workers.find((w) => w.id === JHON)!.kind = "equipo";
    const real = api.listWorkers.bind(api);
    vi.spyOn(api, "listWorkers").mockImplementation(async (...args) =>
      (await real(...args)).map((w) => (w.id === JHON ? { ...w, members: undefined } : w)),
    );

    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter initialEntries={["/nomina"]}>
          <AuthProvider>
            <Routes>
              <Route path="/nomina" element={<CrewPayrollPage />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>,
    );
    const counts = await screen.findAllByText(/\d+ cuentas · \d+ personas/, {}, { timeout: 15_000 });
    const [, accounts, people] = /(\d+) cuentas · (\d+) personas/.exec(counts[0].textContent ?? "")!;
    // María's team adds two heads beyond her account; Jhon's adds none.
    expect(Number(people) - Number(accounts)).toBe(2);
  }, 30_000);
});
