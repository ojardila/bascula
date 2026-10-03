/**
 * The receipt page's own decisions: the PDF button's busy state and its
 * failure, a receipt kind that does not exist, the way back to the history,
 * and the permission screen.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { ReceiptPage } from "./ReceiptPage";
import { downloadReceiptPdf, type PdfOutcome } from "./receiptPdf";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

vi.mock("./receiptPdf", () => ({ downloadReceiptPdf: vi.fn() }));
const download = vi.mocked(downloadReceiptPdf);

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const WEIGHER = "0192f3a0-0001-7000-8000-000000000003";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";
const ADVANCE = `/empleados/${MARIA}/historial/anticipo/0192f3a0-0009-7000-8000-000000000003`;

function renderAt(path: string, userId = OWNER) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route
              path="/empleados/:id"
              element={<p>Historial del empleado</p>}
            />
            <Route
              path="/empleados/:id/historial/:kind/:entryId"
              element={<ReceiptPage />}
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  download.mockReset();
});

describe("Descargar PDF", () => {
  it("says it is preparing while the PDF is made, then goes back to normal", async () => {
    let finish: (o: PdfOutcome) => void = () => {};
    download.mockReturnValue(new Promise((r) => (finish = r)));
    renderAt(ADVANCE);
    await userEvent.click(
      await screen.findByRole("button", { name: /Descargar PDF/ }),
    );
    expect(screen.getByRole("button", { name: /Preparando/ })).toBeDisabled();
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Comprobante de anticipo" }),
    );
    finish("downloaded");
    expect(
      await screen.findByRole("button", { name: /Descargar PDF/ }),
    ).toBeEnabled();
    expect(
      screen.queryByText(/No se pudo crear el PDF/),
    ).not.toBeInTheDocument();
  }, 20000);

  it("says so when the PDF could not be made", async () => {
    download.mockResolvedValue("failed");
    renderAt(ADVANCE);
    await userEvent.click(
      await screen.findByRole("button", { name: /Descargar PDF/ }),
    );
    expect(
      await screen.findByText("No se pudo crear el PDF. Intente otra vez."),
    ).toBeInTheDocument();
  }, 20000);
});

describe("a receipt that cannot be shown", () => {
  it("names a kind of receipt that does not exist, and leads back to the history", async () => {
    renderAt(`/empleados/${MARIA}/historial/factura/x`);
    expect(
      await screen.findByText("Este recibo no existe."),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Volver al historial" }),
    );
    expect(
      await screen.findByText("Historial del empleado"),
    ).toBeInTheDocument();
  });

  it("is not for a weigher", async () => {
    renderAt(ADVANCE, WEIGHER);
    await waitFor(() =>
      expect(screen.getByText(/ver los recibos/)).toBeInTheDocument(),
    );
  });
});
