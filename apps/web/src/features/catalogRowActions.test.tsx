/**
 * The row menu on the activities and expenses lists: taking a row out of
 * service and back, the server refusing either, and the edit dialog opened
 * and closed from the menu. Both screens hand the same callbacks to
 * ModuleList, so they are checked side by side.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import type { ReactElement } from "react";
import { ActivitiesPage } from "./activities/ActivitiesPage";
import { ExpensesPage } from "./expenses/ExpensesPage";
import { AuthProvider } from "../auth/AuthContext";
import { setTokens } from "../api/client";
import { invalidateRefs } from "../api/refs";
import { theme } from "../theme";
import { server } from "../mocks/node";
import * as db from "../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const WEIGHER = "0192f3a0-0001-7000-8000-000000000003";

function renderAs(userId: string, page: ReactElement) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>{page}</AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
});

const screens = [
  {
    name: "activities",
    page: () => <ActivitiesPage />,
    row: "Recolección de café",
    path: "*/v1/activities/:id",
  },
  {
    name: "expenses",
    page: () => <ExpensesPage />,
    row: "Abono para el lote El Alto",
    path: "*/v1/expenses/:id",
  },
] as const;

async function chooseFromMenu(row: string, action: string) {
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: `Acciones de ${row}` }),
  );
  await user.click(await screen.findByRole("menuitem", { name: action }));
  return user;
}

async function confirm(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) {
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: label }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
}

describe.each(screens)("the $name list", (s) => {
  it("takes a row out of service, and brings it back from the inactive filter", async () => {
    renderAs(OWNER, s.page());
    let user = await chooseFromMenu(s.row, "Dar de baja");
    await confirm(user, "Dar de baja");
    await waitFor(() =>
      expect(screen.queryByText(s.row)).not.toBeInTheDocument(),
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Inactivas" }));
    user = await chooseFromMenu(s.row, "Reactivar");
    await confirm(user, "Reactivar");
    await waitFor(() =>
      expect(screen.queryByText(s.row)).not.toBeInTheDocument(),
    );
  }, 20000);

  it("says why when the server refuses, and the note can be closed", async () => {
    server.use(
      http.patch(s.path, () =>
        HttpResponse.json(
          { error: { code: "CONFLICT", message: "No se pudo" } },
          { status: 409 },
        ),
      ),
    );
    renderAs(OWNER, s.page());
    const user = await chooseFromMenu(s.row, "Dar de baja");
    await confirm(user, "Dar de baja");
    const alert = (await screen.findAllByRole("alert")).find(
      (a) => !a.closest('[role="dialog"]'),
    )!;
    expect(screen.getByText(s.row)).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: /cerrar/i }));
    await waitFor(() => expect(alert).not.toBeInTheDocument());
  }, 20000);

  it("opens the row in the edit dialog from the menu, and closes it untouched", async () => {
    renderAs(OWNER, s.page());
    const user = await chooseFromMenu(s.row, "Editar");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(s.row)).toBeInTheDocument();
  }, 20000);
});

describe("the expenses list", () => {
  it("is not for a weigher", async () => {
    renderAs(WEIGHER, <ExpensesPage />);
    expect(await screen.findByText(/ver los gastos/)).toBeInTheDocument();
  });
});
