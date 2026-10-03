// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { TeamFormPage } from "./TeamFormPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { api } from "../../api/endpoints";
import { invalidateRefs } from "../../api/refs";
import type { Worker } from "../../api/types";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { BASKET_LABEL } from "../workers/Basket";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const TEAM = "0192f3a0-0006-7000-8000-0000000000aa";

const person = (p: Partial<Worker>): Worker =>
  ({ id: "p1", name: "Ana", lastName: "Ruiz", tag: null, kind: "persona", team: null, ...p }) as Worker;

function renderAt(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/empleados/equipo/nuevo" element={<TeamFormPage />} />
            <Route path="/empleados/:id/equipo" element={<TeamFormPage />} />
            <Route path="/empleados/:id" element={<div>cuenta del equipo</div>} />
            <Route path="/empleados" element={<div>lista de empleados</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
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
afterEach(() => vi.restoreAllMocks());

describe("editing a team with no basket and no member list", () => {
  beforeEach(() => {
    vi.spyOn(api, "listWorkers").mockResolvedValue([
      person({}),
      person({ id: "p2", name: "Beto", lastName: "Gil", tag: "12", team: { id: "t9", name: "Los Primos" } as Worker["team"] }),
    ]);
    vi.spyOn(api, "getWorker").mockResolvedValue(
      person({ id: TEAM, name: "Las Rosas", lastName: "", kind: "equipo", tag: null, members: undefined }),
    );
  });

  it("names who has no basket and who is in another team, and saves only the name", async () => {
    const update = vi.spyOn(api, "updateWorker").mockResolvedValue(person({ id: TEAM, kind: "equipo" }));
    const user = userEvent.setup();
    renderAt(`/empleados/${TEAM}/equipo`);
    expect(await screen.findByText("Sin canasto")).toBeInTheDocument();
    expect(screen.getByText("Ya está en el equipo Los Primos")).toBeInTheDocument();
    expect(screen.getByText(/todavía no tiene número de canasto/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Guardar equipo" }));
    expect(await screen.findByText("cuenta del equipo")).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(TEAM, { name: "Las Rosas", lastName: "" });
  });

  it("goes back to the team when cancelled", async () => {
    const user = userEvent.setup();
    renderAt(`/empleados/${TEAM}/equipo`);
    await screen.findByText("Sin canasto");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(await screen.findByText("cuenta del equipo")).toBeInTheDocument();
  });
});

describe("the new team form, before the list arrives", () => {
  it("goes back to the list when cancelled", async () => {
    const user = userEvent.setup();
    renderAt("/empleados/equipo/nuevo");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(await screen.findByText("lista de empleados")).toBeInTheDocument();
  });

  it("ignores a list that arrives after the page is gone", async () => {
    let resolve!: (w: Worker[]) => void;
    const listWorkers = vi
      .spyOn(api, "listWorkers")
      .mockReturnValue(new Promise<Worker[]>((r) => (resolve = r)));
    const { unmount } = renderAt("/empleados/equipo/nuevo");
    await waitFor(() => expect(listWorkers).toHaveBeenCalled());
    unmount();
    await act(async () => resolve([person({})]));
    expect(screen.queryByText("Ana Ruiz")).not.toBeInTheDocument();
  });

  it("adds a new person while the list is still loading, already ticked", async () => {
    vi.spyOn(api, "listWorkers").mockReturnValue(new Promise<Worker[]>(() => {}));
    vi.spyOn(api, "createWorker").mockResolvedValue(person({ id: "n1", name: "Nueva", lastName: "", tag: "7" }));
    const user = userEvent.setup();
    renderAt("/empleados/equipo/nuevo");
    expect(screen.getByText("Cargando…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Agregar una persona nueva" }));
    await user.type(screen.getByRole("textbox", { name: /^Nombres/ }), "Nueva");
    await user.type(within(screen.getByRole("dialog")).getByLabelText(new RegExp(`^${BASKET_LABEL}`)), "7");
    await user.click(screen.getByRole("button", { name: "Agregar" }));
    expect(await screen.findByRole("checkbox", { name: "Nueva" })).toBeChecked();
    expect(screen.queryByText("Cargando…")).not.toBeInTheDocument();
  });
});
