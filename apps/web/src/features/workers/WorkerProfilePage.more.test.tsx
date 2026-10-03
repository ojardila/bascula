// SPDX-License-Identifier: MIT
/**
 * A worker's profile, the cases the first file leaves out: a team, a person
 * inside a team, somebody without a basket number or off the payroll, the
 * buttons that leave the page, and a profile that cannot be read.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { WorkerProfilePage } from "./WorkerProfilePage";
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

function renderProfile(id: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[`/empleados/${id}`]}>
        <AuthProvider>
          <Routes>
            <Route path="/empleados/:id" element={<WorkerProfilePage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const where = async () => (await screen.findByTestId("where")).textContent;
const worker = (id: string) =>
  db.tenantOf(db.FARM_ID)!.workers.find((w) => w.id === id)!;

async function makeTeam() {
  await api.createWorker({
    id: TEAM,
    name: "Cuadrilla Norte",
    tag: "40",
    kind: "equipo",
    memberIds: [JHON, LUZ],
  } as never);
  invalidateRefs();
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

describe("a team and its members", () => {
  it("a team's profile lists its members and is paid as a team", async () => {
    await makeTeam();
    const user = userEvent.setup();
    renderProfile(TEAM);
    expect(await screen.findByText("Integrantes")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Registrar deuda" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getAllByRole("button", { name: "Cambiar integrantes" })[0],
    );
    expect(await where()).toBe(`/empleados/${TEAM}/equipo`);
  }, 20000);

  it("a member's profile points to the team and takes no debt of its own", async () => {
    await makeTeam();
    const user = userEvent.setup();
    renderProfile(JHON);
    const banner = (
      await screen.findByRole("button", { name: "Ver el equipo" })
    ).closest(".MuiAlert-root") as HTMLElement;
    expect(banner).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Registrar deuda" }),
    ).not.toBeInTheDocument();
    await user.click(
      within(banner).getByRole("button", { name: "Ver el equipo" }),
    );
    // The team's own profile, on the same route.
    expect(await screen.findByText("Integrantes")).toBeInTheDocument();
  }, 20000);
});

describe("somebody without a number, or off the payroll", () => {
  it("asks for the basket number and goes to the form", async () => {
    worker(MARIA).tag = null as never;
    const user = userEvent.setup();
    renderProfile(MARIA);
    expect(
      await screen.findByText(/Esta persona no tiene número de canasto/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Poner número" }));
    expect(await where()).toBe(`/empleados/${MARIA}/editar`);
  }, 20000);

  it("marks an inactive worker", async () => {
    renderProfile(NUBIA);
    expect(await screen.findByText("Inactivo")).toBeInTheDocument();
  }, 20000);
});

describe("leaving the page", () => {
  it("to pay, back to the list, and the debt dialog opens and closes", async () => {
    const user = userEvent.setup();
    const { unmount } = renderProfile(MARIA);
    await user.click(
      await screen.findByRole("button", { name: "Pagar empleado" }),
    );
    expect(await where()).toBe(`/empleados/${MARIA}/pagar`);
    unmount();

    const second = renderProfile(MARIA);
    await user.click(
      await screen.findByRole("button", { name: "Registrar deuda" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Empleados" }));
    expect(await where()).toBe("/empleados");
    second.unmount();
  }, 30000);
});

describe("a profile that cannot be read", () => {
  it("shows the permission screen on a 403", async () => {
    server.use(
      http.get("*/v1/workers/:id/profile", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    renderProfile(MARIA);
    expect(
      await screen.findByText(/ver el perfil de un empleado/),
    ).toBeInTheDocument();
  }, 20000);

  it("shows the error otherwise", async () => {
    server.use(
      http.get("*/v1/workers/:id/profile", () =>
        HttpResponse.json(
          { error: { code: "BAD_REQUEST", message: "bad" } },
          { status: 400 },
        ),
      ),
    );
    renderProfile(MARIA);
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
  }, 20000);
});
