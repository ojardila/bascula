/**
 * ── ONE FIGURE, ON ALL FOUR SCREENS ──────────────────────────────────────
 *
 * The most damaging finding in the whole review, and the one that is not a bug
 * in a screen but in all of them at once. For the same person on the same day
 * the console said:
 *
 *   the profile        $184.500, in the largest type on the screen
 *   the list           "—" on every row, and "Total a favor: $0" in the footer
 *   the dashboard      $334.500
 *   pay employee       $338.100 — the only correct one, and visible only to
 *                      somebody who had already decided to pay
 *
 * "While three screens give three numbers, they will not believe any of them."
 * That is why this test does not live next to any one of them: what it asserts
 * does not belong to a screen, it is that all four read
 * `features/workers/owed.ts` and not each one its own sum. If anybody adds
 * their own total in any of the four again, this is where it breaks.
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
/** María: a balance in the ledger and three unsettled pieces of work. */
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
 * What the farm owes María, read off the server through the same door
 * settlement uses: `payables.totalCents` is `balanceCents + grossCents`. None
 * of it is computed in the test, so the test cannot agree with itself and
 * disagree with the product.
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

describe("\"how much do I owe them?\" has exactly one answer", () => {
  it("shows the total at the top of the profile, and its two halves below", async () => {
    const total = await owedToMaria();
    renderAt(`/empleados/${MARIA}`);
    await screen.findByText(/Restrepo Ospina/);

    // The big figure is the total, not the ledger balance.
    const card = (await screen.findByText("Lo que se le debe hoy")).closest(
      ".MuiCardContent-root",
    ) as HTMLElement;
    await waitFor(() =>
      expect(within(card).getByText(formatMoney(total))).toBeInTheDocument(),
    );

    // And the breakdown is still there, under the two names the rest of the
    // console uses. Answer first and explain afterwards, not the other way
    // round.
    expect(within(card).getByText("Ya liquidado (saldo del libro)")).toBeInTheDocument();
    expect(within(card).getByText("Pendiente de liquidar")).toBeInTheDocument();
  }, 20000);

  it("says exactly the same thing on the payment screen", async () => {
    const total = await owedToMaria();
    renderAt(`/empleados/${MARIA}/pagar`);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: new RegExp(`Revisar y pagar · \\${formatMoney(total)}`) }),
      ).toBeEnabled(),
    );
  }, 20000);

  it("no longer shows \"—\" on the employee list, nor adds up to zero", async () => {
    const total = await owedToMaria();
    const farm = await owedByTheFarm();
    renderAt("/empleados");

    const row = (await screen.findByText("María Restrepo Ospina")).closest(
      "tr",
    ) as HTMLElement;
    // The column read `w.balanceCents`, which `GET /v1/workers` has never
    // sent: an `undefined` per row, painted as a dash, and summed as a zero.
    await waitFor(() => expect(within(row).getByText(formatMoney(total))).toBeInTheDocument());
    expect(await screen.findByText(formatMoney(farm))).toBeInTheDocument();
  }, 20000);

  it("adds up that same figure on the dashboard, not just the ledgers", async () => {
    const farm = await owedByTheFarm();
    renderAt("/tablero");
    const tile = (await screen.findByText("Lo que la finca les debe a los empleados")).closest(
      ".MuiCardContent-root",
    ) as HTMLElement;
    await waitFor(() => expect(tile).toHaveTextContent(formatMoney(farm)));
  }, 20000);

  /**
   * And the property that makes everything above worth anything: the farm's
   * figure CONTAINS the person's. It did not before — the dashboard summed
   * only the ledgers, so María's unsettled work was on her profile and
   * nowhere else.
   */
  it("includes each person's pending work in the farm total", async () => {
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
