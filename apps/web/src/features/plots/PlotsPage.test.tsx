/**
 * The list of plots: what each row and the footer say about area, where the
 * row and its menu take you, taking a plot out of service (and the server
 * refusing it while something is planted), and what someone who may only
 * look gets.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { PlotsPage } from "./PlotsPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const WEIGHER = "0192f3a0-0001-7000-8000-000000000003";

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderPlots(userId = OWNER) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/lotes"]}>
        <AuthProvider>
          <Routes>
            <Route path="/lotes" element={<PlotsPage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
});

describe("the list", () => {
  it("shows declared and computed area, and a footer that adds only what was declared", async () => {
    const tenant = db.tenantOf(db.FARM_ID)!;
    const cuchilla = tenant.plots.find((p) => p.name === "La Cuchilla")!;
    cuchilla.areaHa = null;
    cuchilla.crops = [];
    renderPlots();
    expect(await screen.findByText("El Alto")).toBeInTheDocument();
    expect(screen.getAllByText(/calculada 4,04 ha/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("sin polígono").length).toBeGreaterThan(0);
    expect(screen.getAllByText("sin cultivos").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/1 sin superficie declarada, que no está en ese total/),
    ).toBeInTheDocument();
  });

  it("marks an out-of-service plot", async () => {
    const user = userEvent.setup();
    renderPlots();
    await screen.findByText("El Alto");
    await user.click(screen.getByRole("button", { name: "Inactivas" }));
    expect(await screen.findByText("San José")).toBeInTheDocument();
    expect(screen.getByText("inactivo")).toBeInTheDocument();
  });

  it("shows the permission screen on a 403", async () => {
    server.use(
      http.get("*/v1/plots", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    renderPlots();
    expect(await screen.findByText(/ver los lotes/)).toBeInTheDocument();
  });
});

describe("going somewhere", () => {
  it("opens a plot from its row", async () => {
    const user = userEvent.setup();
    renderPlots();
    await user.click(await screen.findByText("El Alto"));
    expect(await screen.findByTestId("where")).toHaveTextContent(
      "/lotes/0192f3a0-0004-7000-8000-000000000001",
    );
  });

  it("edits a plot from its menu", async () => {
    const user = userEvent.setup();
    renderPlots();
    await screen.findByText("El Alto");
    await user.click(
      screen.getByRole("button", { name: "Acciones de El Alto" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Editar" }));
    expect(await screen.findByTestId("where")).toHaveTextContent(
      "/lotes/0192f3a0-0004-7000-8000-000000000001/editar",
    );
  });

  it("creates a new one", async () => {
    const user = userEvent.setup();
    renderPlots();
    await screen.findByText("El Alto");
    await user.click(screen.getByRole("button", { name: /Nuevo lote/ }));
    expect(await screen.findByTestId("where")).toHaveTextContent(
      "/lotes/nuevo",
    );
  });
});

describe("out of service", () => {
  it("says why the server refused, and the notice can be closed", async () => {
    const user = userEvent.setup();
    renderPlots();
    await screen.findByText("El Alto");
    await user.click(
      screen.getByRole("button", { name: "Acciones de El Alto" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Dar de baja" }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Dar de baja",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    const alert = await waitFor(() => {
      const el = document.querySelector(".MuiAlert-colorError");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await user.click(
      within(alert).getByRole("button", {
        name: /close|cerrar/i,
        hidden: true,
      }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).toBeNull(),
    );
  });

  it("takes a plot with nothing planted out, and brings one back", async () => {
    const user = userEvent.setup();
    const tenant = db.tenantOf(db.FARM_ID)!;
    tenant.plots.find((p) => p.name === "La Cuchilla")!.crops = [];
    renderPlots();
    await screen.findByText("La Cuchilla");
    await user.click(
      screen.getByRole("button", { name: "Acciones de La Cuchilla" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Dar de baja" }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Dar de baja",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("La Cuchilla")).not.toBeInTheDocument(),
    );

    await user.click(await screen.findByRole("button", { name: "Inactivas" }));
    await screen.findByText("San José");
    await user.click(
      screen.getByRole("button", { name: "Acciones de San José" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Reactivar" }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Reactivar",
      }),
    );
    await waitFor(() =>
      expect(
        tenant.plots.find((p) => p.name === "San José")!.deletedAt,
      ).toBeNull(),
    );
  });
});

describe("someone who may only look", () => {
  it("gets no create button and no edit", async () => {
    const user = userEvent.setup();
    renderPlots(WEIGHER);
    await screen.findByText("El Alto");
    expect(
      screen.queryByRole("button", { name: /Nuevo lote/ }),
    ).not.toBeInTheDocument();
    const menu = screen.queryByRole("button", { name: "Acciones de El Alto" });
    if (menu) {
      await user.click(menu);
      expect(
        screen.queryByRole("menuitem", { name: "Editar" }),
      ).not.toBeInTheDocument();
    }
  });
});
