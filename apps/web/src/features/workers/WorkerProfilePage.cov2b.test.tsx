// SPDX-License-Identifier: MIT
/**
 * A worker's profile, the remaining cases: a team with no basket number, a
 * file with only half of its contact line (or none), a name that reads as two
 * people, an account in the farm's favour after a debt, and a history with a
 * contract and a settled row.
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
const tenant = () => db.tenantOf(db.FARM_ID)!;
const worker = (id: string) => tenant().workers.find((w) => w.id === id)!;

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

describe("WorkerProfilePage", () => {
  it("asks a team without a basket number for one, on the team's form", async () => {
    await api.createWorker({
      id: TEAM, name: "Cuadrilla Norte", tag: "40", kind: "equipo", memberIds: [JHON, LUZ],
    } as never);
    invalidateRefs();
    worker(TEAM).tag = null as never;
    const user = userEvent.setup();
    renderProfile(TEAM);
    expect(
      await screen.findByText(/Este equipo no tiene número de canasto\. Póngale uno para encontrarlo/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Poner número" }));
    expect(await where()).toBe(`/empleados/${TEAM}/equipo`);
  }, 20000);

  it("shows only the phone when there is no document", async () => {
    worker(MARIA).docId = "" as never;
    worker(MARIA).phone = "3205550101";
    renderProfile(MARIA);
    expect(await screen.findByText("3205550101")).toBeInTheDocument();
  }, 20000);

  it("shows only the document when there is no phone", async () => {
    worker(JHON).phone = null;
    renderProfile(JHON);
    expect(await screen.findByText("CC 15322109")).toBeInTheDocument();
  }, 20000);

  it("offers to turn a name that reads as two people into a team, with no contact line", async () => {
    const luz = worker(LUZ);
    luz.name = "Luz y Ana";
    luz.docId = "" as never;
    luz.phone = null;
    const user = userEvent.setup();
    renderProfile(LUZ);
    await user.click(await screen.findByRole("button", { name: "Convertir en equipo" }));
    expect(await where()).toBe(`/empleados/${LUZ}/equipo`);
  }, 20000);

  it("turns the account in the farm's favour after a large debt, and closes the note dialog", async () => {
    const user = userEvent.setup();
    renderProfile(MARIA);
    await user.click(await screen.findByRole("button", { name: "Registrar deuda" }));
    let dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Concepto/), "Préstamo");
    await user.type(within(dialog).getByLabelText(/Valor/), "90000000");
    await user.click(within(dialog).getByRole("button", { name: "Registrar deuda" }));
    expect(await screen.findByText("que el empleado le debe a la finca")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Agregar anotación" }));
    dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  }, 30000);

  it("lists a contract row and a settled row in the history", async () => {
    server.use(
      http.get("*/v1/workers/:id/profile", ({ params }) => {
        const t = tenant();
        const w = worker(params.id as string);
        const tasks = t.workRecords
          .filter((r) => r.workerId === w.id && r.deletedAt === null)
          .slice(0, 2)
          .map((r) => db.projectWorkRecord(t, r));
        expect(tasks).toHaveLength(2);
        tasks[0] = { ...tasks[0], payScheme: "contrato" } as typeof tasks[0];
        tasks[1] = { ...tasks[1], settled: true } as typeof tasks[1];
        return HttpResponse.json({
          worker: w, balance: db.balanceOf(t, w.id), ledger: [], tasks, notes: [],
        });
      }),
    );
    renderProfile(MARIA);
    expect(await screen.findByText("contrato")).toBeInTheDocument();
    expect(screen.getByText("liquidada")).toBeInTheDocument();
  }, 20000);
});
