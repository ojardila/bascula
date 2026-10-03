// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { WorkUnitsPage } from "./WorkUnitsPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderUnits() {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/unidades"]}>
        <AuthProvider>
          <WorkUnitsPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
});

describe("work units, the remaining paths", () => {
  it("says the farm has no units yet", async () => {
    server.use(http.get("*/v1/catalogs/work-units", () => HttpResponse.json({ items: [] })));
    renderUnits();
    expect(await screen.findByText("Esta finca todavía no tiene ninguna unidad.")).toBeInTheDocument();
  });

  it("opens a unit with a kilo factor already written in", async () => {
    const user = userEvent.setup();
    renderUnits();
    await user.click(await screen.findByRole("button", { name: "Editar Kilo" }));
    expect(within(await screen.findByRole("dialog")).getByDisplayValue("1")).toBeInTheDocument();
  });

  it("closes the remove confirmation with Escape", async () => {
    const user = userEvent.setup();
    renderUnits();
    await user.click(await screen.findByRole("button", { name: "Quitar Canasta" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
