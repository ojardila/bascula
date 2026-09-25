/**
 * The weighing screen with no signal: it keeps the weighing on the device,
 * says so, and uploads it with the same id when the server answers again.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { App } from "../App";
import { AuthProvider } from "../auth/AuthContext";
import { setTokens } from "../api/client";
import { invalidateRefs } from "../api/refs";
import { theme } from "../theme";
import { server } from "../mocks/node";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

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
  setTokens({ accessToken: `mock-access.${OWNER}.test`, refreshToken: `mock-refresh.${OWNER}` });
}

beforeEach(() => {
  setTokens(null);
  invalidateRefs();
  localStorage.clear();
});

describe("weighing with no signal", () => {
  it("keeps the weighing on the phone and uploads it later with the same id", async () => {
    signIn();
    const user = userEvent.setup();
    let signal = false;
    const posted: { id: string; quantity: number }[] = [];
    server.use(
      http.post("*/v1/work-records", async ({ request }) => {
        if (!signal) return HttpResponse.error();
        const body = (await request.json()) as { id: string; quantity: number };
        posted.push(body);
        return HttpResponse.json({ ...body, createdAt: "2026-09-25T15:00:00Z" }, { status: 201 });
      }),
    );
    renderApp("/cosecha/recoleccion?quien=uno");
    await user.click(await screen.findByLabelText(/^Persona/));
    await user.click(await screen.findByRole("option", { name: /María Restrepo Ospina/ }));
    await user.click(await screen.findByRole("button", { name: "El Alto" }));
    await user.type(screen.getByLabelText("Kilos"), "37");
    await user.click(screen.getByRole("button", { name: "Guardar pesada" }));

    expect(await screen.findByText(/Guardado en este teléfono: María Restrepo Ospina, 37 kg/)).toBeInTheDocument();
    expect(await screen.findByText("1 pesada por subir")).toBeInTheDocument();
    expect(screen.getByText("Pesadas por subir (1)")).toBeInTheDocument();
    expect(posted).toHaveLength(0);

    signal = true;
    const [upload] = screen.getAllByRole("button", { name: "Subir ahora" });
    await user.click(upload);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].quantity).toBe(37);
    await waitFor(() => expect(screen.queryByText("1 pesada por subir")).not.toBeInTheDocument());
    expect(screen.queryByText(/Pesadas por subir/)).not.toBeInTheDocument();
  }, 20000);

  it("opens the weighing screen from the saved lists when the server cannot be reached", async () => {
    signIn();
    const user = userEvent.setup();
    // First visit with signal fills the device's copy of people and lotes.
    const first = renderApp("/cosecha/recoleccion?quien=uno");
    await user.click(await screen.findByLabelText(/^Persona/));
    expect(await screen.findByRole("option", { name: /María Restrepo Ospina/ })).toBeInTheDocument();
    first.unmount();
    invalidateRefs();

    server.use(
      http.get("*/v1/workers", () => HttpResponse.error()),
      http.get("*/v1/plots", () => HttpResponse.error()),
      http.get("*/v1/activities", () => HttpResponse.error()),
    );
    renderApp("/cosecha/recoleccion?quien=uno");
    expect(await screen.findByText(/Sin señal: usando la lista de personas y lotes guardada/)).toBeInTheDocument();
    await user.click(await screen.findByLabelText(/^Persona/));
    expect(await screen.findByRole("option", { name: /María Restrepo Ospina/ })).toBeInTheDocument();
  }, 20000);
});

describe("opening the app with no signal", () => {
  it("stays signed in as the last user instead of sending them to the login", async () => {
    signIn();
    const first = renderApp("/cosecha/recoleccion?quien=uno");
    expect(await screen.findByLabelText(/^Persona/)).toBeInTheDocument();
    first.unmount();

    server.use(http.get("*/v1/me", () => HttpResponse.error()));
    renderApp("/cosecha/recoleccion?quien=uno");
    expect(await screen.findByLabelText(/^Persona/)).toBeInTheDocument();
  }, 20000);

  it("goes to the login when the server says the session is over", async () => {
    signIn();
    const first = renderApp("/cosecha/recoleccion?quien=uno");
    expect(await screen.findByLabelText(/^Persona/)).toBeInTheDocument();
    first.unmount();

    server.use(http.get("*/v1/me", () => HttpResponse.json({ error: { code: "UNAUTHORIZED", message: "no" } }, { status: 401 })));
    renderApp("/cosecha/recoleccion?quien=uno");
    expect(await screen.findByRole("button", { name: "Entrar" })).toBeInTheDocument();
  }, 20000);
});
