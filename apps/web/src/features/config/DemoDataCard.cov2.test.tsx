// SPDX-License-Identifier: MIT
/** Demo data on a session that does not carry the farm's timezone: Bogotá. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { DemoDataCard } from "./DemoDataCard";
import { AuthProvider } from "../../auth/AuthContext";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";
import { OWNER, signInOwner } from "../../test/renderWithAuth";
import { todayInFarm } from "../../lib/dates";

const demo = vi.hoisted(() => ({
  farmIsEmpty: vi.fn<() => Promise<boolean>>(),
  loadDemoData: vi.fn<(today: string) => Promise<{ workers: number; weighings: number }>>(),
}));
vi.mock("./demoData", () => demo);

beforeEach(() => {
  signInOwner();
  demo.farmIsEmpty.mockReset();
  demo.loadDemoData.mockReset();
});

describe("DemoDataCard", () => {
  it("loads the demo for today in Bogotá when the session has no timezone", async () => {
    server.use(
      http.get("*/v1/me", () =>
        HttpResponse.json({
          id: OWNER,
          email: "oscar@laesperanza.co",
          name: "Oscar Jaramillo",
          role: "owner",
          farm: { id: db.FARM_ID, name: "La Esperanza", currency: "COP", slug: "la-esperanza" },
          superadmin: false,
        }),
      ),
    );
    demo.farmIsEmpty.mockResolvedValue(true);
    demo.loadDemoData.mockResolvedValue({ workers: 6, weighings: 120 });
    const user = userEvent.setup();
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <AuthProvider>
            <DemoDataCard />
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Cargar datos de demostración" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cargar" }));
    expect(
      await screen.findByText(/Listo: 6 empleados y 120 pesadas/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(demo.loadDemoData.mock.calls[0][0]).toBe(todayInFarm("America/Bogota")),
    );
  }, 20000);
});
