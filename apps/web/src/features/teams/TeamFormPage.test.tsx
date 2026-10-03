// SPDX-License-Identifier: MIT
/**
 * «Nuevo equipo»: a name, the people, save. The team is created with its
 * members and each member then points back at it (docs/use-cases/teams.md).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { TeamFormPage } from "./TeamFormPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

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

function renderTeamForm() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/empleados/equipo/nuevo"]}>
        <AuthProvider>
          <Routes>
            <Route path="/empleados/equipo/nuevo" element={<TeamFormPage />} />
            <Route path="/empleados/:id" element={<div>cuenta del equipo</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("creating a team", () => {
  it("creates one account with its members, and the members point at it", async () => {
    const t = db.tenantOf(db.FARM_ID)!;
    const [a, b] = t.workers.filter((w) => w.deletedAt == null);
    const user = userEvent.setup();
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter initialEntries={["/empleados/equipo/nuevo"]}>
          <AuthProvider>
            <Routes>
              <Route path="/empleados/equipo/nuevo" element={<TeamFormPage />} />
              <Route path="/empleados/:id" element={<div>cuenta del equipo</div>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>,
    );
    await user.type(screen.getByLabelText(/^Nombre del equipo/), "Los dos");
    await user.type(screen.getByLabelText(/^Número de canasto/), "90-91");
    const nameA = `${a.name} ${a.lastName ?? ""}`.trim();
    const nameB = `${b.name} ${b.lastName ?? ""}`.trim();
    await user.click(await screen.findByRole("checkbox", { name: nameA }));
    await user.click(screen.getByRole("checkbox", { name: nameB }));
    expect(screen.getByText("2 personas.")).toBeInTheDocument();
    expect(screen.getByText(/los kilos se dividen entre 2/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Guardar equipo" }));

    expect(await screen.findByText("cuenta del equipo")).toBeInTheDocument();
    const team = t.workers.find((w) => w.name === "Los dos")!;
    expect(team.kind).toBe("equipo");
    // The team has its own basket number; the members keep theirs.
    expect(team.tag).toBe("90-91");
    expect(t.workers.find((w) => w.id === a.id)!.tag).toBe(a.tag);
    expect(team.members?.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect(t.workers.find((w) => w.id === a.id)!.team?.id).toBe(team.id);
  }, 20000);

  it("asks for the team's basket number, and says who has it if it is taken", async () => {
    const t = db.tenantOf(db.FARM_ID)!;
    const holder = t.workers.find((w) => w.deletedAt == null && w.tag)!;
    const user = userEvent.setup();
    renderTeamForm();
    await user.type(screen.getByLabelText(/^Nombre del equipo/), "Los tres");
    await user.click(screen.getByRole("button", { name: "Guardar equipo" }));
    expect(await screen.findByText("Escriba el número de canasto.")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Número de canasto/), holder.tag!);
    await user.click(screen.getByRole("button", { name: "Guardar equipo" }));
    const who = `${holder.name} ${holder.lastName ?? ""}`.trim();
    expect(await screen.findByText(`Ese número ya lo tiene ${who}.`)).toBeInTheDocument();
    expect(t.workers.find((w) => w.name === "Los tres")).toBeUndefined();
  }, 20000);
});
