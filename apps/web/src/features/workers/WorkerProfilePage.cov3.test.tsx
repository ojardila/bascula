// SPDX-License-Identifier: MIT
/**
 * A worker's profile, last cases: a suspended farm (it can look but not
 * write, so the missing basket number comes without the button to fix it), a
 * balance the ledger could not give, a file with its start date, and a note
 * that arrives with its author's name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { WorkerProfilePage } from "./WorkerProfilePage";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { api } from "../../api/endpoints";
import type { WorkerProfile } from "../../api/types";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { OWNER, signInOwner } from "../../test/renderWithAuth";
import { server } from "../../mocks/node";

const MARIA = "0192f3a0-0006-7000-8000-000000000001";

function c3wRender() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[`/empleados/${MARIA}`]}>
        <AuthProvider>
          <Routes>
            <Route path="/empleados/:id" element={<WorkerProfilePage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** The real profile, changed by `edit` on its way to the screen. */
function c3wProfile(edit: (p: WorkerProfile) => WorkerProfile) {
  const real = api.workerProfile.bind(api);
  vi.spyOn(api, "workerProfile").mockImplementation(async (...args) => edit(await real(...args)));
}

beforeEach(() => {
  signInOwner();
  invalidateRefs();
});
afterEach(() => vi.restoreAllMocks());

describe("WorkerProfilePage", () => {
  it("on a suspended farm, names the missing basket number but offers no button", async () => {
    // The farm's standing comes from the user kept on this device while
    // /v1/me cannot be read, the way the read-only shell test does it.
    localStorage.setItem(
      "bascula.lastUser",
      JSON.stringify({
        id: OWNER,
        email: "oscar@laesperanza.co",
        name: "Oscar",
        role: "owner",
        isSuperAdmin: false,
        farm: {
          id: db.FARM_ID, name: "La Esperanza", slug: "x", timezone: "America/Bogota",
          currency: "COP", status: "suspended", trialDaysLeft: null,
        },
        memberships: [],
      }),
    );
    server.use(
      http.get("*/v1/me", () =>
        HttpResponse.json({ error: { code: "UNAVAILABLE", message: "down" } }, { status: 503 }),
      ),
    );
    c3wProfile((p) => ({ ...p, worker: { ...p.worker, tag: null } }));
    c3wRender();
    expect(await screen.findByText(/Esta persona no tiene número de canasto/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Poner número" })).not.toBeInTheDocument();
  });

  it("says the direction of the balance could not be established, and gives the start date", async () => {
    c3wProfile((p) => ({
      ...p,
      // A ledger that could not be read arrives without a figure.
      balance: { ...p.balance, balanceCents: null as unknown as number },
      worker: { ...p.worker, startedAt: "2024-03-04" },
    }));
    c3wRender();
    expect(await screen.findByText("no se pudo establecer")).toBeInTheDocument();
    expect(screen.getByText(/^Trabaja desde /)).toHaveTextContent(/2024/);
  });

  it("signs a note with its author when the server sends one", async () => {
    c3wProfile((p) => ({
      ...p,
      notes: [{ id: "n-c3w", text: "Pidió el viernes", date: "2026-09-04", authorName: "Marta" }],
    }));
    c3wRender();
    expect(await screen.findByText("Pidió el viernes")).toBeInTheDocument();
    expect(screen.getByText(/ · Marta$/)).toBeInTheDocument();
  });
});
