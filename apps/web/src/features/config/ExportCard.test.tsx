// SPDX-License-Identifier: MIT
/**
 * The «Descargar datos» card itself: each button builds its file and hands
 * it to the browser, says which file it was, and says so when the browser
 * refused or the data could not be read. `ExportCard.test.ts` covers the
 * CSV contents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { ExportCard } from "./ExportCard";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";
import * as csv from "../../lib/csv";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderCard() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <ExportCard />
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
afterEach(() => vi.restoreAllMocks());

describe("each button", () => {
  it.each([
    ["Pesadas", "pesadas", /Se descargó bascula-.*-pesadas-\d{4}-\d{2}-\d{2}\.csv\./],
    ["Movimientos de dinero", "movimientos", /Se descargó bascula-.*-movimientos-\d{4}-\d{2}-\d{2}\.csv\./],
    ["Saldos por empleado", "saldos", /Se descargó bascula-.*-saldos-\d{4}-\d{2}-\d{2}\.csv\./],
  ] as const)(
    "«%s» downloads its file and names it",
    async (label, kind, message) => {
      const download = vi.spyOn(csv, "downloadCsv").mockReturnValue(true);
      const user = userEvent.setup();
      renderCard();
      await user.click(await screen.findByRole("button", { name: label }));
      const done = await screen.findByText(message);
      expect(download).toHaveBeenCalledTimes(1);
      expect(download.mock.calls[0][0]).toContain(`-${kind}-`);
      await user.click(
        within(done.closest(".MuiAlert-root") as HTMLElement).getByRole(
          "button",
          { name: /close|cerrar/i },
        ),
      );
      await waitFor(() =>
        expect(screen.queryByText(/Se descargó/)).not.toBeInTheDocument(),
      );
    },
    20000,
  );
});

describe("when it cannot", () => {
  it("says the browser refused the download", async () => {
    vi.spyOn(csv, "downloadCsv").mockReturnValue(false);
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Pesadas" }));
    expect(
      await screen.findByText("El navegador no permitió descargar el archivo."),
    ).toBeInTheDocument();
  }, 20000);

  it("says the data could not be read, and the notice can be closed", async () => {
    const download = vi.spyOn(csv, "downloadCsv").mockReturnValue(true);
    server.use(
      http.get("*/v1/work-records", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "x" } },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Pesadas" }));
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    expect(download).not.toHaveBeenCalled();
    await user.click(
      within(
        document.querySelector(".MuiAlert-colorError") as HTMLElement,
      ).getByRole("button", {
        name: /close|cerrar/i,
      }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).toBeNull(),
    );
  }, 20000);
});
