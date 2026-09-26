/**
 * The harvest sheet is a table a farm fills. These check that the matrix
 * actually loads people and days, and that saving posts a weighing.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { users } from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const ALTO = "0192f3a0-0004-7000-8000-000000000001";
const WEEK = "2026-08-24";

function renderApp(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function signIn() {
  const user = users.find((u) => u.id === OWNER);
  if (!user) throw new Error("no owner");
  setTokens({ accessToken: `mock-access.${OWNER}.test`, refreshToken: `mock-refresh.${OWNER}` });
}

beforeEach(() => {
  setTokens(null);
  invalidateRefs();
  localStorage.clear();
});

describe("Planilla de recolección", () => {
  it("loads the week as a matrix of people and days", async () => {
    signIn();
    renderApp(`/labores/planilla?lunes=${WEEK}&lote=${ALTO}`);
    expect(await screen.findByRole("heading", { name: "Planilla de la semana" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Semana" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("María Restrepo Ospina")).toBeInTheDocument();
    expect(screen.getByText("Jhon Fredy Cardona Loaiza")).toBeInTheDocument();
    // Wednesday 26 Aug is in that week and already has 41 kg for María.
    const cell = await screen.findByLabelText(/María Restrepo Ospina, X 26/);
    expect((cell as HTMLInputElement).value).toBe("41");
  }, 20000);

  it("saves a new cell as a work record", async () => {
    signIn();
    const user = userEvent.setup();
    const posted: unknown[] = [];
    server.use(
      http.post("*/v1/work-records", async ({ request }) => {
        const body = await request.json();
        posted.push(body);
        return HttpResponse.json({ ...(body as object), createdAt: "2026-08-24T22:00:00Z" }, { status: 201 });
      }),
    );
    renderApp(`/labores/planilla?lunes=${WEEK}&lote=${ALTO}`);
    const monday = await screen.findByLabelText(/María Restrepo Ospina, L 24/);
    await user.clear(monday);
    await user.type(monday, "40");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const body = posted[0] as { quantity: number; dateFrom: string; plotIds: string[] };
    expect(body.dateFrom).toBe("2026-08-24");
    expect(body.plotIds).toEqual([ALTO]);
    expect(body.quantity).toBe(40);
  }, 20000);

  it("registers kilos for one lote on one day, per person", async () => {
    signIn();
    const user = userEvent.setup();
    const posted: unknown[] = [];
    server.use(
      http.post("*/v1/work-records", async ({ request }) => {
        const body = await request.json();
        posted.push(body);
        return HttpResponse.json({ ...(body as object), createdAt: "2026-08-26T22:00:00Z" }, { status: 201 });
      }),
    );
    // An old «Masiva» link lands on the day planilla it used to show.
    renderApp(`/cosecha/recoleccion?quien=todos&dia=2026-08-26&lote=${ALTO}`);
    expect(await screen.findByRole("heading", { name: "Planilla del día" })).toBeInTheDocument();
    const kilos = await screen.findByLabelText(/Jhon Fredy Cardona Loaiza, kilos/);
    await user.type(kilos, "55");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const body = posted[0] as { quantity: number; dateFrom: string; plotIds: string[] };
    expect(body.dateFrom).toBe("2026-08-26");
    expect(body.plotIds).toEqual([ALTO]);
    expect(body.quantity).toBe(55);
  }, 20000);

  it("registers one person at a time", async () => {
    signIn();
    const user = userEvent.setup();
    const posted: unknown[] = [];
    server.use(
      http.post("*/v1/work-records", async ({ request }) => {
        const body = await request.json();
        posted.push(body);
        return HttpResponse.json({ ...(body as object), createdAt: "2026-08-26T22:00:00Z" }, { status: 201 });
      }),
    );
    const { unmount } = renderApp("/cosecha/recoleccion");
    expect(await screen.findByRole("heading", { name: "Registrar una recolección" })).toBeInTheDocument();
    const person = await screen.findByLabelText(/^Persona/);
    await user.click(person);
    await user.click(await screen.findByRole("option", { name: /María Restrepo Ospina/ }));
    await user.click(await screen.findByRole("button", { name: "El Alto" }));
    await user.type(screen.getByLabelText("Kilos"), "42");
    await user.click(screen.getByRole("button", { name: "Guardar pesada" }));
    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const body = posted[0] as { quantity: number; workerId: string };
    expect(body.quantity).toBe(42);
    // The person clears for the next one in line; the lote stays.
    expect(await screen.findByText(/Guardado: María Restrepo Ospina, 42 kg/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "El Alto" })).toHaveAttribute("aria-pressed", "true");
    expect((screen.getByLabelText(/^Persona/) as HTMLInputElement).value).toBe("");

    // The same person can come back with another load the same day.
    await user.click(screen.getByLabelText(/^Persona/));
    await user.click(await screen.findByRole("option", { name: /María Restrepo Ospina/ }));
    await user.type(screen.getByLabelText("Kilos"), "42");
    await user.click(screen.getByRole("button", { name: "Guardar pesada" }));
    await waitFor(() => expect(posted.length).toBe(2));
    expect((posted[1] as { id: string }).id).not.toBe((posted[0] as { id: string }).id);

    // Next time the screen opens on this device, the lote is already chosen.
    unmount();
    renderApp("/cosecha/recoleccion");
    await waitFor(() => expect(screen.getByRole("button", { name: "El Alto" })).toHaveAttribute("aria-pressed", "true"));
  }, 20000);

  it("asks before saving a weight nobody carries, and saves nothing on «Corregir»", async () => {
    const user = userEvent.setup();
    signIn();
    const posted: unknown[] = [];
    server.use(
      http.post("*/v1/work-records", async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    renderApp("/cosecha/recoleccion?quien=uno");
    await user.click(await screen.findByLabelText(/^Persona/));
    await user.click(await screen.findByRole("option", { name: /María Restrepo Ospina/ }));
    await user.click(await screen.findByRole("button", { name: "El Alto" }));
    await user.type(screen.getByLabelText("Kilos"), "420");
    await user.click(screen.getByRole("button", { name: "Guardar pesada" }));
    expect(await screen.findByText("¿420 kg en una sola pesada?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Corregir" }));
    expect(posted).toHaveLength(0);
  }, 20000);

  it("registers the whole week, asking before it saves", async () => {
    signIn();
    const user = userEvent.setup();
    const posted: unknown[] = [];
    server.use(
      http.post("*/v1/work-records", async ({ request }) => {
        const body = await request.json();
        posted.push(body);
        return HttpResponse.json({ ...(body as object), createdAt: "2026-08-24T22:00:00Z" }, { status: 201 });
      }),
    );
    renderApp(`/cosecha/registrar-semana?lunes=${WEEK}&lote=${ALTO}`);
    expect(await screen.findByRole("heading", { name: "Registrar la semana" })).toBeInTheDocument();
    const cell = await screen.findByLabelText(/Jhon Fredy Cardona Loaiza, L 24/);
    await user.type(cell, "35");
    expect(screen.getByText("1 cambio sin guardar")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Guardar la semana" }));
    expect(await screen.findByText("¿Guardar la semana?")).toBeInTheDocument();
    expect(posted).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Sí, guardar" }));
    await waitFor(() => expect(posted.length).toBe(1));
    const body = posted[0] as { quantity: number; dateFrom: string; plotIds: string[] };
    expect(body).toMatchObject({ quantity: 35, dateFrom: "2026-08-24", plotIds: [ALTO] });
    expect(await screen.findByText(/Se guardó 1 pesada/)).toBeInTheDocument();
  }, 20000);
});
