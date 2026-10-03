// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

vi.setConfig({ testTimeout: 30_000 });

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const ALTO = "0192f3a0-0004-7000-8000-000000000001";

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  localStorage.clear();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

describe("PlanillaSheet", () => {
  it("asks to register people first when nobody is active", async () => {
    for (const w of db.tenantOf(db.FARM_ID)!.workers) w.deletedAt = "2026-01-01T00:00:00Z";
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter initialEntries={[`/labores/planilla?modo=dia&lote=${ALTO}&dia=2026-08-24`]}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(
      await screen.findByText(/No hay empleados activos\. Regístrelos primero para llenar la/),
    ).toBeInTheDocument();
  });
});
