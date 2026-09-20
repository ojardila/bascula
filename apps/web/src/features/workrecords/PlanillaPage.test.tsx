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
    expect(await screen.findByRole("heading", { name: "Planilla de recolección" })).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Guardar planilla" }));
    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const body = posted[0] as { quantity: number; dateFrom: string; plotIds: string[] };
    expect(body.dateFrom).toBe("2026-08-24");
    expect(body.plotIds).toEqual([ALTO]);
    expect(body.quantity).toBe(40);
  }, 20000);
});
