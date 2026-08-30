/**
 * ── UNA SOLA CIFRA, EN LAS CUATRO PANTALLAS ──────────────────────────────
 *
 * El hallazgo que más daño hacía de toda la revisión, y el que no es un fallo
 * de una pantalla sino de todas a la vez. Para la misma persona y el mismo día
 * la consola decía:
 *
 *   el perfil          $184.500, en el tipo más grande de la pantalla
 *   la lista           «—» en cada fila, y «Total a favor: $0» en el pie
 *   el tablero         $334.500
 *   pagar empleado     $338.100 — la única correcta, y sólo visible para quien
 *                      ya había decidido pagar
 *
 * «Mientras tres pantallas den tres números, no le va a creer a ninguno.» Por
 * eso esta prueba no vive junto a ninguna de ellas: lo que afirma no es de una
 * pantalla, es que las cuatro leen `features/workers/owed.ts` y no cada una su
 * propia suma. Si alguien vuelve a sumar por su cuenta en cualquiera de las
 * cuatro, es aquí donde se rompe.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { WorkerProfilePage } from "../features/workers/WorkerProfilePage";
import { WorkersPage } from "../features/workers/WorkersPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { PayWorkerPage } from "../features/workers/PayWorkerPage";
import { AuthProvider } from "../auth/AuthContext";
import { setTokens } from "../api/client";
import { invalidateRefs } from "../api/refs";
import { theme } from "../theme";
import * as db from "../mocks/db";
import { api } from "../api/endpoints";
import { formatMoney } from "../lib/money";
import { owedByWorker, sumOwedToFarmWorkers, totalOwedCents } from "../features/workers/owed";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
/** María: saldo en el libro y tres labores sin liquidar. */
const MARIA = "0192f3a0-0006-7000-8000-000000000001";

function renderAt(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/tablero" element={<DashboardPage />} />
            <Route path="/empleados" element={<WorkersPage />} />
            <Route path="/empleados/:id" element={<WorkerProfilePage />} />
            <Route path="/empleados/:id/pagar" element={<PayWorkerPage />} />
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

/**
 * Lo que la finca le debe a María, leído del servidor por la misma puerta que
 * usa la liquidación: `payables.totalCents` es `balanceCents + grossCents`.
 * Nada de esto se calcula en la prueba, para que la prueba no pueda estar de
 * acuerdo consigo misma y en desacuerdo con el producto.
 */
async function owedToMaria(): Promise<number> {
  const [balance, payables] = await Promise.all([
    api.workerBalance(MARIA),
    api.workerPayables(MARIA),
  ]);
  return balance.balanceCents + payables.grossCents;
}

async function owedByTheFarm(): Promise<number> {
  const [balances, records] = await Promise.all([
    api.listBalances(),
    api.listWorkRecords({ status: "active" }),
  ]);
  const sum = sumOwedToFarmWorkers([...owedByWorker(balances, records).values()]);
  return sum.cents!;
}

describe("«¿cuánto le debo?» tiene una sola respuesta", () => {
  it("el perfil enseña el total arriba, y sus dos mitades debajo", async () => {
    const total = await owedToMaria();
    renderAt(`/empleados/${MARIA}`);
    await screen.findByText(/Restrepo Ospina/);

    // La cifra grande es el total, no el saldo del libro.
    const card = (await screen.findByText("Lo que se le debe hoy")).closest(
      ".MuiCardContent-root",
    ) as HTMLElement;
    await waitFor(() =>
      expect(within(card).getByText(formatMoney(total))).toBeInTheDocument(),
    );

    // Y el desglose sigue estando, con los dos nombres que usa el resto de la
    // consola. Responder primero y explicar después, no al revés.
    expect(within(card).getByText("Ya liquidado (saldo del libro)")).toBeInTheDocument();
    expect(within(card).getByText("Pendiente de liquidar")).toBeInTheDocument();
  }, 20000);

  it("la pantalla de pagar dice exactamente lo mismo", async () => {
    const total = await owedToMaria();
    renderAt(`/empleados/${MARIA}/pagar`);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: new RegExp(`Revisar y pagar · \\${formatMoney(total)}`) }),
      ).toBeEnabled(),
    );
  }, 20000);

  it("la lista de empleados ya no dice «—» ni suma cero", async () => {
    const total = await owedToMaria();
    const farm = await owedByTheFarm();
    renderAt("/empleados");

    const row = (await screen.findByText("María Restrepo Ospina")).closest(
      "tr",
    ) as HTMLElement;
    // La columna leía `w.balanceCents`, que `GET /v1/workers` nunca ha enviado:
    // un `undefined` por fila, pintado como guion, y sumado como cero.
    await waitFor(() => expect(within(row).getByText(formatMoney(total))).toBeInTheDocument());
    expect(await screen.findByText(formatMoney(farm))).toBeInTheDocument();
  }, 20000);

  it("y el tablero suma esa misma cifra, no sólo los libros", async () => {
    const farm = await owedByTheFarm();
    renderAt("/tablero");
    const tile = (await screen.findByText("Lo que la finca les debe a los empleados")).closest(
      ".MuiCardContent-root",
    ) as HTMLElement;
    await waitFor(() => expect(tile).toHaveTextContent(formatMoney(farm)));
  }, 20000);

  /**
   * Y la propiedad que hace que todo lo anterior valga algo: la cifra de la
   * finca CONTIENE la de la persona. Antes no: el tablero sumaba sólo los
   * libros, así que las labores sin liquidar de María estaban en su perfil y
   * en ninguna otra parte.
   */
  it("el total de la finca incluye lo pendiente de cada persona", async () => {
    const [balances, records] = await Promise.all([
      api.listBalances(),
      api.listWorkRecords({ status: "active" }),
    ]);
    const accounts = owedByWorker(balances, records);
    const maria = totalOwedCents(accounts.get(MARIA)!)!;
    expect(maria).toBe(await owedToMaria());

    const onlyLedgers = balances.reduce((a, b) => a + Math.max(0, b.balanceCents), 0);
    const farm = await owedByTheFarm();
    expect(farm).toBeGreaterThan(onlyLedgers);
  }, 20000);
});
