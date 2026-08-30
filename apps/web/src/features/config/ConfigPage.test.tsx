/**
 * "ESTADO: ACTIVE" — in English, and made up on top of that.
 *
 * The chip read the farm status off the SESSION. `/v1/me` reports no farm
 * lifecycle at all — the payload is id, name, timezone and currency — so
 * `toMeUser` filled it in with the constant "active". That inference is fair
 * for deciding read-only (a live token means a farm that is not suspended) and
 * it is not a fact to print: the screen showed a hard-coded English enum as
 * though the server had sent it.
 *
 * `GET /v1/farm` has the real column, `suspendedAt`. Until it answers there is
 * nothing to show, and "—" is what nothing looks like.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { ConfigPage } from "./ConfigPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderConfig() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/configuracion"]}>
        <AuthProvider>
          <ConfigPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** The row the "Estado" label sits in. */
function statusRow() {
  return screen.getByText("Estado").parentElement as HTMLElement;
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

describe("the farm status", () => {
  it("is written in Spanish and comes from /v1/farm", async () => {
    renderConfig();
    await waitFor(() => expect(statusRow()).toHaveTextContent("Activa"));
    // The raw enum was what the screen printed before.
    expect(statusRow()).not.toHaveTextContent("active");
  }, 20000);

  it("shows an em dash while the status is unknown, instead of assuming the farm is active", async () => {
    server.use(
      http.get("*/v1/farm", () =>
        HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
      ),
    );
    renderConfig();
    // The session would happily have said "active" here — it always does.
    await waitFor(() => expect(statusRow()).toHaveTextContent("—"));
    expect(statusRow()).not.toHaveTextContent("Activa");
  }, 20000);

  it("and shows Suspendida when the farm is suspended", async () => {
    server.use(
      http.get("*/v1/farm", () =>
        HttpResponse.json({
          id: db.FARM_ID,
          name: "La Esperanza",
          timezone: "America/Bogota",
          currency: "COP",
          suspendedAt: "2026-08-01T00:00:00Z",
          priceCents: 80_000,
          areaHa: null,
          city: null,
          country: null,
          phone: null,
          address: null,
        }),
      ),
    );
    renderConfig();
    await waitFor(() => expect(statusRow()).toHaveTextContent("Suspendida"));
  }, 20000);
});
