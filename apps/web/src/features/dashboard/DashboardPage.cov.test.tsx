/**
 * The dashboard's remaining edges: the owed tile when the ledger is down, the
 * plots tile when the farm's lots are forbidden or undeclared, the week's
 * kilos when there are some, and every tile and button as a door.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { DashboardPage } from "./DashboardPage";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { signInOwner } from "../../test/renderWithAuth";
import { todayInFarm } from "../../lib/dates";

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

function renderDashboard() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/tablero"]}>
        <AuthProvider>
          <Routes>
            <Route path="/tablero" element={<DashboardPage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function tile(label: RegExp | string) {
  return screen.getByText(label).closest(".MuiCardContent-root") as HTMLElement;
}

function record(over: Record<string, unknown>) {
  return {
    id: "0192f3a0-0008-7000-8000-0000000000bb",
    workerId: "0192f3a0-0006-7000-8000-000000000001",
    activityId: "0192f3a0-0007-7000-8000-000000000001",
    payScheme: "por_unidad",
    rateSource: "explicit",
    dateFrom: `${todayInFarm("America/Bogota")}T12:00:00Z`,
    dateTo: `${todayInFarm("America/Bogota")}T12:00:00Z`,
    quantity: "37",
    unitId: "0192f3a0-000d-7000-8000-000000000001",
    rateCents: 100_000,
    amountCents: 3_700_000,
    estimatedAmountCents: 3_700_000,
    amountIsEstimate: false,
    note: null,
    createdBy: null,
    createdAt: "2026-08-27T22:15:00Z",
    deletedAt: null,
    plotIds: [],
    plotCropIds: [],
    settled: false,
    ...over,
  };
}

beforeEach(() => {
  signInOwner();
  invalidateRefs();
});

describe("DashboardPage edges", () => {
  it('the owed tile says "—" when the balances cannot be read', async () => {
    server.use(
      http.get("*/v1/balances", () =>
        HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
      ),
    );
    renderDashboard();
    const owed = tile("Lo que la finca les debe a los empleados");
    await waitFor(() => expect(owed).toHaveTextContent("no se pudo consultar"));
    expect(owed).toHaveTextContent("—");
  }, 20000);

  it("counts zero lots when the lots are forbidden, and says how many are undeclared otherwise", async () => {
    server.use(
      http.get("*/v1/plots", () =>
        HttpResponse.json({ error: { code: "FORBIDDEN", message: "no" } }, { status: 403 }),
      ),
    );
    const { unmount } = renderDashboard();
    const plots = tile("Lotes activos");
    await waitFor(() => expect(plots).toHaveTextContent(/ha declaradas/));
    expect(within(plots).getByText("0")).toBeInTheDocument();
    unmount();
  }, 20000);

  it("adds a note for lots without a declared area", async () => {
    server.use(
      http.get("*/v1/plots", () =>
        HttpResponse.json({
          items: [
            { id: "p1", name: "Uno", areaHa: 2, status: "active" },
            { id: "p2", name: "Dos", areaHa: null, status: "active" },
          ],
        }),
      ),
    );
    renderDashboard();
    const plots = tile("Lotes activos");
    await waitFor(() => expect(plots).toHaveTextContent("1 sin declarar"));
    expect(within(plots).getByText("2")).toBeInTheDocument();
  }, 20000);

  it("adds up this week's kilos", async () => {
    server.use(
      http.get("*/v1/work-records", () =>
        HttpResponse.json({
          items: [record({}), record({ id: "x2", unitId: "0192f3a0-000d-7000-8000-000000000002", quantity: "5" })],
        }),
      ),
    );
    renderDashboard();
    const kg = tile(/Kilos de la semana/);
    await waitFor(() => expect(kg).toHaveTextContent("37 kg"));
  }, 20000);

  it.each([
    ["Fijar precio del kilo", "/precio-semana"],
    ["Pagar nómina", "/nomina"],
    ["Registrar labor", "/labores/nueva"],
    ["Nuevo empleado", "/empleados/nuevo"],
    [/Nuevo lote/i, "/lotes/nuevo"],
  ])("the %s button opens %s", async (name, path) => {
    const user = userEvent.setup();
    renderDashboard();
    await user.click(await screen.findByRole("button", { name }));
    expect(await screen.findByTestId("where")).toHaveTextContent(path);
  }, 20000);

  it("a tile is a door to its screen", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await user.click(screen.getByText("Pendiente de liquidar"));
    expect(await screen.findByTestId("where")).toHaveTextContent("/labores");
  }, 20000);
});
