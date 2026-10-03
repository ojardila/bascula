// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { SettlementDetailPage } from "./SettlementDetailPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { api } from "../../api/endpoints";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";
import * as print from "../documents/print";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const SEEDED = "0192f3a0-000b-7000-8000-000000000001";

function renderAt() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[`/liquidaciones/${SEEDED}`]}>
        <AuthProvider>
          <Routes>
            <Route path="/liquidaciones/:id" element={<SettlementDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function signIn() {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
});
afterEach(() => vi.restoreAllMocks());

describe("a settlement's page, the rest", () => {
  it("says the person may not see it", async () => {
    signIn();
    server.use(
      http.get("*/v1/settlements/:id", () =>
        HttpResponse.json({ error: { code: "FORBIDDEN", message: "no" } }, { status: 403 }),
      ),
    );
    renderAt();
    expect(await screen.findByText(/ver una liquidación/)).toBeInTheDocument();
  });

  it("shows the server's error", async () => {
    signIn();
    server.use(
      http.get("*/v1/settlements/:id", () =>
        HttpResponse.json({ error: { code: "NOT_FOUND", message: "La liquidación no existe." } }, { status: 404 }),
      ),
    );
    renderAt();
    expect(await screen.findByText(/No encontramos ese registro/)).toBeInTheDocument();
  });

  it("marks a settlement voided at an unknown time, and prints with the fallback farm name", async () => {
    signIn();
    const real = await api.getSettlement(SEEDED);
    vi.spyOn(api, "getSettlement").mockResolvedValue({ ...real, status: "void", voidedAt: null });
    setTokens(null);
    const printDocument = vi.spyOn(print, "printDocument").mockReturnValue(true);
    const user = userEvent.setup();
    renderAt();
    const alert = (await screen.findByText("Liquidación anulada")).closest("[role=alert]")!;
    expect(alert.textContent).toMatch(/^Liquidación anulada\. Las labores/);
    await user.click(screen.getByRole("button", { name: "Imprimir" }));
    expect(printDocument.mock.calls[0][0]).toContain("Finca");
  });
});
