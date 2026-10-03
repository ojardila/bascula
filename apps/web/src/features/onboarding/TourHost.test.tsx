// SPDX-License-Identifier: MIT
/**
 * The tour host decides what the running step shows: the welcome dialog, the
 * closing dialog with what the owner did, nothing for a paused tour, and the
 * route a step lives on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { TourHost } from "./TourHost";
import { TourContext, type TourContextValue } from "./TourContext";
import { OWNER_DONE, stepOf, stepsOf, type TourName } from "./steps";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function fakeTour(
  over: Partial<TourContextValue> & { at?: [TourName, number] },
): TourContextValue {
  const { at, ...rest } = over;
  const def = at ? stepOf(at[0], at[1]) : undefined;
  return {
    current: at && def ? { tour: at[0], n: at[1], def } : null,
    paused: false,
    saved: {},
    loaded: true,
    available: "owner",
    summary: { owners: 0, people: 0, plot: null, priceCents: null },
    start: vi.fn(),
    resume: vi.fn(),
    goTo: vi.fn(),
    pause: vi.fn(),
    later: vi.fn(),
    dismiss: vi.fn(),
    finish: vi.fn(),
    isAt: () => false,
    registerAction: () => () => {},
    runAction: async () => true,
    note: vi.fn(),
    ...rest,
  };
}

function renderHost(value: TourContextValue, path = "/cosecha") {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <TourContext.Provider value={value}>
            <Routes>
              <Route
                path="*"
                element={
                  <>
                    <TourHost />
                    <Where />
                  </>
                }
              />
            </Routes>
          </TourContext.Provider>
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

describe("TourHost", () => {
  it("shows nothing without a tour, or while it is paused", () => {
    const { unmount } = renderHost(fakeTour({}));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    unmount();
    renderHost(fakeTour({ at: ["owner", 0], paused: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("welcomes the owner and starts or postpones the tour", async () => {
    const user = userEvent.setup();
    const t = fakeTour({ at: ["owner", 0] });
    renderHost(t);
    expect(await screen.findByText(/¡Bienvenido a /)).toBeInTheDocument();
    expect(screen.getByText("Poner el precio del kilo")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Empezar" }));
    expect(t.goTo).toHaveBeenCalledWith(1);
    await user.click(
      screen.getByRole("button", { name: "Ahora no, más tarde" }),
    );
    expect(t.later).toHaveBeenCalled();
  });

  it("closes with what the owner did and where to go next", async () => {
    const user = userEvent.setup();
    const t = fakeTour({
      at: ["owner", OWNER_DONE],
      summary: { owners: 1, people: 2, plot: "El Alto", priceCents: 120000 },
    });
    renderHost(t);
    expect(
      await screen.findByText("¡Su finca quedó lista!"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Precio del kilo: /)).toBeInTheDocument();
    expect(
      screen.getByText("Invitó a 1 socio y 2 personas"),
    ).toBeInTheDocument();
    expect(screen.getByText("Creó el lote «El Alto»")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Agregar empleados" }));
    expect(t.finish).toHaveBeenCalled();
    expect(screen.getByTestId("where")).toHaveTextContent("/empleados/nuevo");
  });

  it("reads the price from the farm when the tour did not note it", async () => {
    const t = fakeTour({
      at: ["owner", OWNER_DONE],
      summary: { owners: 2, people: 1, plot: null, priceCents: null },
    });
    renderHost(t);
    expect(await screen.findByText(/Precio del kilo: /)).toBeInTheDocument();
    expect(
      screen.getByText("Invitó a 2 socios y 1 persona"),
    ).toBeInTheDocument();
  });

  it.each([
    ["Registrar una recolección", "/cosecha/recoleccion"],
    ["Registro de recolección masivo", "/cosecha/registro-masivo"],
  ])("«%s» ends the tour and goes to %s", async (label, to) => {
    const user = userEvent.setup();
    const t = fakeTour({ at: ["owner", OWNER_DONE] });
    renderHost(t);
    await user.click(await screen.findByRole("button", { name: label }));
    expect(t.finish).toHaveBeenCalled();
    expect(screen.getByTestId("where")).toHaveTextContent(to);
  });

  it("takes the person to the page a step lives on", async () => {
    const step = stepsOf("owner").find(
      (s) => s.kind === "spot" && s.route && s.route !== "/cosecha",
    );
    expect(step).toBeTruthy();
    renderHost(fakeTour({ at: ["owner", step!.n] }), "/cosecha");
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent(step!.route!),
    );
  });

  it("shows nothing for a step that is not a spotlight", () => {
    const step = stepsOf("owner").find(
      (s) => s.kind !== "spot" && s.n !== 0 && s.n !== OWNER_DONE,
    );
    if (!step) return;
    renderHost(fakeTour({ at: ["owner", step.n] }), step.route ?? "/cosecha");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
