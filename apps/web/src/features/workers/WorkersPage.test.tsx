// SPDX-License-Identifier: MIT
/**
 * «Empleados»: the list, what the farm owes in the footer (and what it could
 * not read), every row action, and the refusals of a deactivation or a
 * reactivation.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { WorkersPage } from "./WorkersPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { api } from "../../api/endpoints";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";
const JHON = "0192f3a0-0006-7000-8000-000000000002";
const LUZ = "0192f3a0-0006-7000-8000-000000000003";
const NUBIA = "0192f3a0-0006-7000-8000-000000000005";
const TEAM = "0192f3a0-0006-7000-8000-0000000000e1";

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderList() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/empleados"]}>
        <AuthProvider>
          <Routes>
            <Route path="/empleados" element={<WorkersPage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const where = async () => (await screen.findByTestId("where")).textContent;
const boom = () =>
  HttpResponse.json(
    { error: { code: "BAD_REQUEST", message: "bad" } },
    { status: 400 },
  );

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

type User = ReturnType<typeof userEvent.setup>;

async function rowAction(user: User, who: RegExp, action: string) {
  await user.click(await screen.findByRole("button", { name: who }));
  await user.click(await screen.findByRole("menuitem", { name: action }));
}

describe("the footer", () => {
  it("counts the people and says what the farm owes them", async () => {
    renderList();
    expect(await screen.findByText(/^\d+ empleados$/)).toBeInTheDocument();
    expect(await screen.findByText(/La finca les debe/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/La finca les debe/)).not.toHaveTextContent("…"),
    );
  }, 20000);

  it("says a dash and not zero when no account could be read", async () => {
    server.use(
      http.get("*/v1/balances", boom),
      http.get("*/v1/work-records", boom),
    );
    renderList();
    const owes = await screen.findByText(/La finca les debe/);
    await waitFor(() => expect(owes).toHaveTextContent("—"));
  }, 20000);
});

describe("row actions", () => {
  it("open the profile, the form, the payment and the person's team", async () => {
    await api.createWorker({
      id: TEAM,
      name: "Cuadrilla Norte",
      tag: "40",
      kind: "equipo",
      memberIds: [JHON, LUZ],
    } as never);
    invalidateRefs();
    const user = userEvent.setup();
    const views: string[] = [];
    for (const [who, action] of [
      [/Acciones de María/, "Ver detalle"],
      [/Acciones de María/, "Editar"],
      [/Acciones de María/, "Pagar"],
      [/Acciones de Cuadrilla Norte/, "Editar"],
      [/Acciones de Jhon Fredy/, "Ver su equipo"],
    ] as const) {
      const { unmount } = renderList();
      await rowAction(user, who, action);
      views.push((await where())!);
      unmount();
    }
    expect(views).toEqual([
      `/empleados/${MARIA}`,
      `/empleados/${MARIA}/editar`,
      `/empleados/${MARIA}/pagar`,
      `/empleados/${TEAM}/equipo`,
      `/empleados/${TEAM}`,
    ]);
  }, 40000);

  it("the toolbar creates a person or a team", async () => {
    const user = userEvent.setup();
    const { unmount } = renderList();
    await user.click(
      await screen.findByRole("button", { name: "Nuevo equipo" }),
    );
    expect(await where()).toBe("/empleados/equipo/nuevo");
    unmount();
    renderList();
    await user.click(
      (await screen.findAllByRole("button", { name: "Nuevo empleado" }))[0],
    );
    expect(await where()).toBe("/empleados/nuevo");
  }, 20000);
});

describe("taking somebody off the payroll and back", () => {
  it("deactivates a person", async () => {
    const user = userEvent.setup();
    renderList();
    await rowAction(user, /Acciones de María/, "Dar de baja");
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Dar de baja" }),
    );
    await waitFor(() =>
      expect(
        db.tenantOf(db.FARM_ID)!.workers.find((w) => w.id === MARIA)!.deletedAt,
      ).not.toBeNull(),
    );
  }, 20000);

  it("says why a deactivation was refused, and the message closes", async () => {
    server.use(http.patch("*/v1/workers/:id", boom));
    const user = userEvent.setup();
    renderList();
    await rowAction(user, /Acciones de María/, "Dar de baja");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Dar de baja",
      }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    const alert = document.querySelector(".MuiAlert-colorError") as HTMLElement;
    await user.click(
      within(alert).getByRole("button", {
        name: /close|cerrar/i,
        hidden: true,
      }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).toBeNull(),
    );
  }, 20000);

  it("reactivates somebody who left, or says why it could not", async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(await screen.findByRole("button", { name: "Inactivas" }));
    await rowAction(user, /Acciones de Nubia/, "Reactivar");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Reactivar",
      }),
    );
    await waitFor(() =>
      expect(
        db.tenantOf(db.FARM_ID)!.workers.find((w) => w.id === NUBIA)!.deletedAt,
      ).toBeNull(),
    );

    db.tenantOf(db.FARM_ID)!.workers.find((w) => w.id === NUBIA)!.deletedAt =
      "2026-05-04T16:00:00Z";
    server.use(http.patch("*/v1/workers/:id", boom));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await user.click(await screen.findByRole("button", { name: "Todas" }));
    await rowAction(user, /Acciones de Nubia/, "Reactivar");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Reactivar",
      }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
  }, 30000);
});

describe("who may see it", () => {
  it("shows the permission screen on a 403", async () => {
    server.use(
      http.get("*/v1/workers", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    renderList();
    expect(await screen.findByText(/ver los empleados/)).toBeInTheDocument();
  }, 20000);
});
