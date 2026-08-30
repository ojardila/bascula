/**
 * EL PERFIL DEL EMPLEADO, CUANDO NO SABE — y cuando lo que sabe es provisional.
 *
 * "Pendiente de liquidar" does not come from `/v1/workers/{id}/profile`. It is
 * a second request, `/v1/workers/{id}/payables`, fired in parallel and caught
 * so that a payables outage does not blank the ledger and the notes. The catch
 * was right; what it did with the failure was not: `payables?.grossCents ?? 0`
 * turned an unreachable route into the figure zero.
 *
 * The result was a screen that looks like a person who is square with the
 * farm. Somebody owed $868.000 read "$0" — and because the detail block below
 * was gated on `pendingCents > 0`, it vanished too, leaving nothing on the
 * page to suggest anything was missing.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { WorkerProfilePage } from "./WorkerProfilePage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";

function renderProfile() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[`/empleados/${MARIA}`]}>
        <AuthProvider>
          <Routes>
            <Route path="/empleados/:id" element={<WorkerProfilePage />} />
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

describe("cuando no se pueden consultar los pendientes", () => {
  it("dice «—» y lo explica, en vez de un $0 que parece paz y salvo", async () => {
    server.use(
      http.get("*/v1/workers/:id/payables", () =>
        HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
      ),
    );
    renderProfile();
    await screen.findByText(/Restrepo Ospina/);

    const row = screen.getByText("Pendiente de liquidar").closest("div")!.parentElement!;
    await waitFor(() => expect(row).toHaveTextContent("—"));
    expect(row).not.toHaveTextContent("$0");

    // And the failure is stated in words, because a dash on its own is a
    // question. This line is also the block that used to disappear entirely,
    // since it was gated on the fallback zero being greater than zero.
    expect(
      await screen.findByText("No se pudo consultar lo pendiente de liquidar. No es cero."),
    ).toBeInTheDocument();

    // The rest of the profile still loads: catching the failure was right.
    expect(screen.getByText("Historial financiero")).toBeInTheDocument();
  }, 20000);

  it("y cuando sí se puede, muestra la cifra", async () => {
    renderProfile();
    await screen.findByText(/Restrepo Ospina/);
    await waitFor(() =>
      expect(
        screen.queryByText("No se pudo consultar lo pendiente de liquidar. No es cero."),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Pendiente de liquidar")).toBeInTheDocument();
  }, 20000);
});

describe("lo provisional no se muestra como definitivo", () => {
  it("marca las labores que todavía se pagan al precio de la semana", async () => {
    renderProfile();
    const table = (await screen.findByText("Labores")).closest(".MuiCardContent-root")!;
    // The seeded farm prices its picking by the week, so these rows are not
    // decided. `amountIsEstimate` is the server's own flag and had no reader
    // anywhere in the console before this.
    expect(
      (await within(table as HTMLElement).findAllByText(/provisional · al precio de la semana/)).length,
    ).toBeGreaterThan(0);
  }, 20000);
});

/**
 * ── UNA TABLA QUE DECÍA SER TODO Y ERA UNA PÁGINA ────────────────────────
 *
 * `/v1/workers/{id}/profile` corta el libro por `?limit` —cincuenta por
 * defecto en el servidor— y la respuesta no lleva ni el tope ni el total. La
 * consola pintaba lo que llegara bajo el título «Historial financiero», así
 * que a quien lleva dos temporadas en la finca se le enseñaba media cuenta sin
 * una palabra. Es de la misma familia que el resto de la auditoría: una
 * pantalla afirmando más de lo que sabe.
 */
describe("el historial no finge ser más largo de lo que es", () => {
  it("avisa, con el número, cuando el libro viene cortado", async () => {
    const t = db.tenantOf(db.FARM_ID)!;
    const one = t.ledger.find((l) => l.workerId === MARIA)!;
    // Sesenta asientos: más que el tope que pide la pantalla.
    for (let i = 0; i < 60; i++) {
      t.ledger.push({ ...one, id: `${one.id}-relleno-${i}` });
    }
    renderProfile();
    expect(
      await screen.findByText(/Se muestran los 50 movimientos más recientes/),
    ).toBeInTheDocument();
  }, 20000);

  it("y no lo dice cuando de verdad están todos", async () => {
    renderProfile();
    await screen.findByText("Historial financiero");
    await waitFor(() =>
      expect(screen.queryByText(/Se muestran los 50/)).not.toBeInTheDocument(),
    );
  }, 20000);
});
