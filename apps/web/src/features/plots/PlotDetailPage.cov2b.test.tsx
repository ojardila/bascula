// SPDX-License-Identifier: MIT
/**
 * One plot's page: the refusals, the buttons that take you elsewhere, and
 * what it says when the area, the crops, the point or the work are missing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { PlotDetailPage } from "./PlotDetailPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const EL_ALTO = "0192f3a0-0004-7000-8000-000000000001";
const LA_CUCHILLA = "0192f3a0-0004-7000-8000-000000000002";
const SAN_JOSE = "0192f3a0-0004-7000-8000-000000000004";

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderPlot(id: string) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[`/lotes/${id}`]}>
        <AuthProvider>
          <Routes>
            <Route path="/lotes/:id" element={<PlotDetailPage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const refuse = (status: number, code: string) =>
  http.get("*/v1/plots/:id", () =>
    HttpResponse.json({ error: { code, message: code } }, { status }),
  );

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
});

describe("when the plot cannot be shown", () => {
  it("shows the permission screen on a 403", async () => {
    server.use(refuse(403, "FORBIDDEN"));
    renderPlot(EL_ALTO);
    expect(await screen.findByText(/ver este lote/)).toBeInTheDocument();
  });

  it("says what went wrong on any other failure", async () => {
    server.use(refuse(500, "INTERNAL"));
    renderPlot(EL_ALTO);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });
});

describe("going somewhere from a plot", () => {
  it("goes back to the list", async () => {
    const user = userEvent.setup();
    renderPlot(EL_ALTO);
    await screen.findByRole("heading", { name: "El Alto" });
    await user.click(screen.getByRole("button", { name: "Lotes" }));
    expect(await screen.findByTestId("where")).toHaveTextContent(/^\/lotes$/);
  });

  it("edits it from the header", async () => {
    const user = userEvent.setup();
    renderPlot(EL_ALTO);
    await screen.findByRole("heading", { name: "El Alto" });
    await user.click(screen.getByRole("button", { name: "Editar" }));
    expect(await screen.findByTestId("where")).toHaveTextContent(
      `/lotes/${EL_ALTO}/editar`,
    );
  });

  it("re-marks a point that is already saved", async () => {
    const user = userEvent.setup();
    renderPlot(EL_ALTO);
    await screen.findByRole("heading", { name: "El Alto" });
    expect(screen.getByText(/Punto guardado/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Volver a marcar" }));
    expect(await screen.findByTestId("where")).toHaveTextContent(
      `/lotes/${EL_ALTO}/editar`,
    );
  });
});

describe("what is missing", () => {
  it("an out-of-service plot with no crops, no point and no work", async () => {
    server.use(
      http.get("*/v1/work-records", () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    renderPlot(SAN_JOSE);
    await screen.findByRole("heading", { name: "San José" });
    expect(screen.getByText("Inactiva")).toBeInTheDocument();
    expect(
      screen.getByText("Este lote no tiene cultivos registrados."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Marcar el punto" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nadie ha marcado dónde queda/)).toBeInTheDocument();
    expect(
      await screen.findByText("Todavía no hay labores registradas sobre este lote."),
    ).toBeInTheDocument();
  });

  it("an undeclared area and a crop with nothing but its type", async () => {
    const plot = db.tenantOf(db.FARM_ID)!.plots.find((p) => p.id === LA_CUCHILLA)!;
    plot.areaHa = null;
    plot.crops[0].variety = null;
    plot.crops[0].areaHa = null;
    plot.crops[0].plantedOn = null;
    renderPlot(LA_CUCHILLA);
    await screen.findByRole("heading", { name: "La Cuchilla" });
    expect(
      screen.getByText("Nadie ha declarado cuántas hectáreas tiene este lote."),
    ).toBeInTheDocument();
    const row = screen.getByRole("row", { name: /Café/ });
    expect(row).toHaveTextContent("Café———");
  });

  it("shows no work at all while the work cannot be read", async () => {
    server.use(
      http.get("*/v1/work-records", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "x" } },
          { status: 500 },
        ),
      ),
    );
    renderPlot(EL_ALTO);
    await screen.findByRole("heading", { name: "El Alto" });
    expect(screen.getByText("Últimas labores")).toBeInTheDocument();
    expect(
      screen.queryByText("Todavía no hay labores registradas sobre este lote."),
    ).not.toBeInTheDocument();
  });
});
