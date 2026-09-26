/**
 * The worker's history opens a receipt, and the receipt is the one that was
 * written that day, with its PDF button.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { WorkerProfilePage } from "../workers/WorkerProfilePage";
import { ReceiptPage } from "./ReceiptPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";

function renderAt(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/empleados/:id" element={<WorkerProfilePage />} />
            <Route path="/empleados/:id/historial/:kind/:entryId" element={<ReceiptPage />} />
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

describe("the financial history", () => {
  it("lists payments, settlements, advances and discounts and opens a payment's receipt", async () => {
    renderAt(`/empleados/${MARIA}`);
    const history = await screen.findByTestId("worker-history");
    expect(history).toHaveTextContent("Pago");
    expect(history).toHaveTextContent("Liquidación");
    expect(history).toHaveTextContent("Anticipo");
    expect(history).toHaveTextContent("Descuento");

    await userEvent.click(screen.getAllByRole("button", { name: /^Ver pago del/ })[0]);
    expect(await screen.findByRole("heading", { name: "Recibo de pago" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Descargar PDF/ })).toBeInTheDocument();
    const view = screen.getByTestId("receipt-view");
    expect(view).toHaveTextContent("Saldo anterior");
    expect(view).toHaveTextContent("Pagado");
    expect(view).toHaveTextContent("Queda");
  }, 20000);

  it("opens an advance as its own slip", async () => {
    renderAt(`/empleados/${MARIA}/historial/anticipo/0192f3a0-0009-7000-8000-000000000003`);
    expect(await screen.findByRole("heading", { name: "Comprobante de anticipo" })).toBeInTheDocument();
    expect(screen.getByTestId("receipt-view")).toHaveTextContent("Anticipo entregado");
  }, 20000);
});
