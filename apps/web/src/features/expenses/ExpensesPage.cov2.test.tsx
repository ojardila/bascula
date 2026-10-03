// SPDX-License-Identifier: MIT
/**
 * The expense list with targets whose names did not come back (an activity
 * or a lote since removed), the singular "suma" under «Todas», and the form
 * opened before the activities and lotes have loaded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse, delay } from "msw";
import { ExpensesPage } from "./ExpensesPage";
import { AuthProvider } from "../../auth/AuthContext";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { FARM_ID, tenantOf } from "../../mocks/db";
import { signInOwner } from "../../test/renderWithAuth";

vi.setConfig({ testTimeout: 30_000 });

function renderExpenses() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/gastos"]}>
        <AuthProvider>
          <ExpensesPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => signInOwner());

describe("ExpensesPage — names that did not come back", () => {
  it("says «actividad» and «lote» when the server has no name, and «suma» for one live expense", async () => {
    const t = tenantOf(FARM_ID)!;
    const base = t.expenses[0];
    t.expenses = [
      {
        ...base,
        id: "0192f3a0-eeee-7000-8000-000000000001",
        concept: "Gasto de actividad borrada",
        activityId: "0192f3a0-eeee-7000-8000-0000000000aa",
        plotId: null,
        plotCropId: null,
        deletedAt: null,
      },
      {
        ...base,
        id: "0192f3a0-eeee-7000-8000-000000000002",
        concept: "Gasto de lote borrado",
        activityId: null,
        plotId: "0192f3a0-eeee-7000-8000-0000000000bb",
        plotCropId: null,
        deletedAt: "2026-01-01T00:00:00Z",
      },
    ];
    const user = userEvent.setup();
    renderExpenses();
    const row = (await screen.findByText("Gasto de actividad borrada")).closest("tr")!;
    expect(within(row).getByText("actividad")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Todas" }));
    const gone = (await screen.findByText("Gasto de lote borrado")).closest("tr")!;
    expect(within(gone).getByText("lote")).toBeInTheDocument();
    expect(screen.getByText(/1 sigue activo y suma/)).toBeInTheDocument();
  });
});

describe("ExpensesPage — the form before the lists arrive", () => {
  it("opens «Registrar gasto» even while activities and lotes are still loading", async () => {
    server.use(
      http.get("*/v1/activities", async () => {
        await delay("infinite");
        return HttpResponse.json({ items: [] });
      }),
      http.get("*/v1/plots", async () => {
        await delay("infinite");
        return HttpResponse.json({ items: [] });
      }),
    );
    const user = userEvent.setup();
    renderExpenses();
    await user.click(await screen.findByRole("button", { name: /Registrar gasto/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Registrar gasto")).toBeInTheDocument();
  });
});
