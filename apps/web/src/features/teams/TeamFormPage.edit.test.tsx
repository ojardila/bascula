// SPDX-License-Identifier: MIT
/**
 * The team form beyond creating one: the name it asks for, the search, adding
 * a new person from the dialog, turning a person into a team, changing an
 * existing team's members, and the errors on the way.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { TeamFormPage } from "./TeamFormPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const t = () => db.tenantOf(db.FARM_ID)!;
const people = () =>
  t().workers.filter((w) => w.deletedAt == null && w.kind !== "equipo");
const fullName = (w: { name: string; lastName?: string | null }) =>
  `${w.name} ${w.lastName ?? ""}`.trim();

function renderAt(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/empleados/equipo/nuevo" element={<TeamFormPage />} />
            <Route path="/empleados/:id/equipo" element={<TeamFormPage />} />
            <Route
              path="/empleados/:id"
              element={<div>cuenta del equipo</div>}
            />
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

describe("the new team form", () => {
  it("asks for a name and goes back to the list", async () => {
    const user = userEvent.setup();
    renderAt("/empleados/equipo/nuevo");
    await user.click(screen.getByRole("button", { name: "Guardar equipo" }));
    expect(
      await screen.findByText("Escriba el nombre del equipo."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Empleados" }));
    expect(await screen.findByText("lista de empleados")).toBeInTheDocument();
  });

  it("finds people by name and says when nobody matches", async () => {
    const user = userEvent.setup();
    const [first, second] = people();
    renderAt("/empleados/equipo/nuevo");
    await screen.findByLabelText(fullName(first));
    await user.type(
      screen.getByPlaceholderText("Buscar trabajador"),
      first.name,
    );
    expect(screen.getByLabelText(fullName(first))).toBeInTheDocument();
    if (second && !fullName(second).includes(first.name)) {
      expect(screen.queryByLabelText(fullName(second))).not.toBeInTheDocument();
    }
    await user.clear(screen.getByPlaceholderText("Buscar trabajador"));
    await user.type(
      screen.getByPlaceholderText("Buscar trabajador"),
      "zzzz nadie",
    );
    expect(
      screen.getByText("No hay nadie con ese nombre."),
    ).toBeInTheDocument();
  });

  it("toggles a person on and off", async () => {
    const user = userEvent.setup();
    const [first] = people();
    renderAt("/empleados/equipo/nuevo");
    const box = await screen.findByLabelText(fullName(first));
    await user.click(box);
    expect(box).toBeChecked();
    await user.click(box);
    expect(box).not.toBeChecked();
  });

  it("adds a new person from the dialog and marks them", async () => {
    const user = userEvent.setup();
    renderAt("/empleados/equipo/nuevo");
    await screen.findByLabelText(fullName(people()[0]));
    await user.click(
      screen.getByRole("button", { name: "Agregar una persona nueva" }),
    );
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Agregar" }));
    expect(within(dialog).getByText("Escriba el nombre.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^Nombres/), "Yorman");
    await user.click(within(dialog).getByRole("button", { name: "Agregar" }));
    expect(
      within(dialog).getByText("Escriba el número de canasto."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    await user.click(
      screen.getByRole("button", { name: "Agregar una persona nueva" }),
    );
    dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Nombres/), "Yorman");
    await user.type(within(dialog).getByLabelText(/^Apellidos/), "Ruiz");
    await user.type(within(dialog).getByLabelText(/^Número de canasto/), "977");
    await user.click(within(dialog).getByRole("button", { name: "Agregar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Yorman Ruiz")).toBeChecked();
    expect(
      t().workers.some((w) => w.name === "Yorman" && w.tag === "977"),
    ).toBe(true);
  });

  it("says who has the number when the new person's basket is taken", async () => {
    const user = userEvent.setup();
    const holder = people().find((w) => w.tag)!;
    renderAt("/empleados/equipo/nuevo");
    await screen.findByLabelText(fullName(people()[0]));
    await user.click(
      screen.getByRole("button", { name: "Agregar una persona nueva" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Nombres/), "Otro");
    await user.type(
      within(dialog).getByLabelText(/^Número de canasto/),
      holder.tag!,
    );
    await user.click(within(dialog).getByRole("button", { name: "Agregar" }));
    expect(
      await within(dialog).findByText(
        `Ese número ya lo tiene ${fullName(holder)}.`,
      ),
    ).toBeInTheDocument();
  });

  it("shows the server's message when the new person cannot be saved", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/v1/workers", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "x" } },
          { status: 500 },
        ),
      ),
    );
    renderAt("/empleados/equipo/nuevo");
    await screen.findByLabelText(fullName(people()[0]));
    await user.click(
      screen.getByRole("button", { name: "Agregar una persona nueva" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Nombres/), "Otro");
    await user.type(within(dialog).getByLabelText(/^Número de canasto/), "981");
    await user.click(within(dialog).getByRole("button", { name: "Agregar" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toBeInTheDocument(),
    );
  });

  it("shows the server's message when the team cannot be saved", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/v1/workers", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "x" } },
          { status: 500 },
        ),
      ),
    );
    renderAt("/empleados/equipo/nuevo");
    await user.type(screen.getByLabelText(/^Nombre del equipo/), "Los dos");
    await user.type(screen.getByLabelText(/^Número de canasto/), "46-63");
    await user.click(screen.getByRole("button", { name: "Guardar equipo" }));
    await waitFor(() =>
      expect(screen.getAllByRole("alert").length).toBeGreaterThan(0),
    );
    expect(screen.queryByText("cuenta del equipo")).not.toBeInTheDocument();
  });

  it("says so when the people cannot be loaded", async () => {
    server.use(
      http.get("*/v1/workers", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "x" } },
          { status: 500 },
        ),
      ),
    );
    renderAt("/empleados/equipo/nuevo");
    await waitFor(() =>
      expect(screen.getAllByRole("alert").length).toBeGreaterThan(0),
    );
  });
});

describe("editing", () => {
  it("turns a person into a team that keeps their number", async () => {
    const user = userEvent.setup();
    const [who, mate] = people();
    renderAt(`/empleados/${who.id}/equipo`);
    expect(await screen.findByText("Convertir en equipo")).toBeInTheDocument();
    expect(screen.getByText(/Se queda con sus pesadas/)).toBeInTheDocument();
    await user.click(await screen.findByLabelText(fullName(mate)));
    if (!who.tag)
      await user.type(screen.getByLabelText(/^Número de canasto/), "990");
    await user.click(screen.getByRole("button", { name: /Guardar/ }));
    expect(await screen.findByText("cuenta del equipo")).toBeInTheDocument();
    expect(t().workers.find((w) => w.id === who.id)!.kind).toBe("equipo");
  });

  it("changes an existing team's members and goes back", async () => {
    const user = userEvent.setup();
    const [a, b, c] = people();
    // make a team through the form first
    renderAt("/empleados/equipo/nuevo");
    await user.type(screen.getByLabelText(/^Nombre del equipo/), "Los dos");
    await user.type(screen.getByLabelText(/^Número de canasto/), "46-63");
    await user.click(await screen.findByLabelText(fullName(a)));
    await user.click(screen.getByLabelText(fullName(b)));
    await user.click(screen.getByRole("button", { name: "Guardar equipo" }));
    await screen.findByText("cuenta del equipo");
    const team = t().workers.find((w) => w.name === "Los dos")!;

    document.body.innerHTML = "";
    renderAt(`/empleados/${team.id}/equipo`);
    expect(await screen.findByText("Cambiar integrantes")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText(fullName(a))).toBeChecked(),
    );
    expect(
      screen.queryByLabelText(/¿Desde qué día cuenta este cambio\?/),
    ).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(fullName(c)));
    expect(
      screen.getAllByText(/¿Desde qué día cuenta este cambio\?/).length,
    ).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /Guardar/ }));
    expect(await screen.findByText("cuenta del equipo")).toBeInTheDocument();
  });

  it("goes back to the team's account", async () => {
    const user = userEvent.setup();
    const [who] = people();
    renderAt(`/empleados/${who.id}/equipo`);
    await screen.findByText("Convertir en equipo");
    await user.click(screen.getByRole("button", { name: "Volver" }));
    expect(await screen.findByText("cuenta del equipo")).toBeInTheDocument();
  });
});
