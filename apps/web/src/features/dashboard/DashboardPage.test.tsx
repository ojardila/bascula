/**
 * EL TABLERO, CUANDO NO SABE.
 *
 * This screen has carried a function called `Unknown` since Sprint 1, with a
 * comment explaining that a "$0" here "makes a failed request
 * indistinguishable from being square with everybody". The comment was right
 * and only half applied: the two money tiles used it and the two tiles beside
 * them printed "0 kg" and "0" out of the very same failed requests. "Kilos de
 * la semana" and "Pendiente de liquidar" both come from
 * `GET /v1/work-records`; with that route down, one said "—" and the other
 * said "0 kg", side by side.
 *
 * The other half of the file is the estimate. On the seeded farm every
 * unsettled labor is priced by the week, so "Pendiente de liquidar" is 100%
 * provisional — and `amountIsEstimate`, the flag the server sends expressly to
 * say so, had no reader anywhere in `features/`.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { DashboardPage } from "./DashboardPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderDashboard() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/tablero"]}>
        <AuthProvider>
          <DashboardPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** The card a tile's label sits in, so an assertion cannot drift to another. */
function tile(label: RegExp | string) {
  return screen.getByText(label).closest(".MuiCardContent-root") as HTMLElement;
}

const down = (path: string) =>
  http.get(path, () =>
    HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
  );

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

describe("cuando una petición se cae", () => {
  it("los kilos de la semana dicen «—», no «0 kg»", async () => {
    server.use(down("*/v1/work-records"));
    renderDashboard();

    // The money tile from the same request already did this correctly.
    const money = tile("Pendiente de liquidar");
    await waitFor(() => expect(money).toHaveTextContent("—"));

    // And the kilos, out of the identical failure, used to say "0 kg" — which
    // is a week in which nobody picked anything.
    const kg = tile(/Kilos de la semana/);
    expect(kg).toHaveTextContent("—");
    expect(kg).not.toHaveTextContent("0 kg");
    expect(kg).toHaveTextContent("no se pudo consultar");
  }, 20000);

  it("las parcelas activas dicen «—», no «0»", async () => {
    server.use(down("*/v1/plots"));
    renderDashboard();

    const plots = tile("Parcelas activas");
    await waitFor(() => expect(plots).toHaveTextContent("—"));
    // "0 parcelas activas" describes a farm that does not exist, and it came
    // out of `plots?.length ?? 0` on a GET that never answered.
    expect(plots).not.toHaveTextContent("0,00 ha");
    expect(plots).toHaveTextContent("no se pudo consultar");
  }, 20000);
});

describe("lo estimado no se muestra como definitivo", () => {
  it("marca «Pendiente de liquidar» como precio de la semana", async () => {
    renderDashboard();
    const money = tile("Pendiente de liquidar");
    // The figure is shown — hiding it would be worse — but it is labelled.
    expect(await within(money).findByText(/estimado · precio de la semana/)).toBeInTheDocument();
  }, 20000);

  /** …and it is not a decoration stapled to every figure. */
  it("no marca lo que ya está congelado", async () => {
    server.use(
      http.get("*/v1/work-records", () =>
        HttpResponse.json({
          items: [
            {
              id: "0192f3a0-0008-7000-8000-0000000000aa",
              workerId: "0192f3a0-0006-7000-8000-000000000001",
              activityId: "0192f3a0-0007-7000-8000-000000000002",
              payScheme: "contrato",
              rateSource: "explicit",
              dateFrom: "2026-08-27T00:00:00Z",
              dateTo: "2026-08-27T00:00:00Z",
              quantity: 1,
              unitId: null,
              rateCents: 5_000_000,
              amountCents: 5_000_000,
              estimatedAmountCents: 5_000_000,
              amountIsEstimate: false,
              note: null,
              createdBy: null,
              createdAt: "2026-08-27T22:15:00Z",
              deletedAt: null,
              plotIds: [],
              plotCropIds: [],
              settled: false,
            },
          ],
        }),
      ),
    );
    renderDashboard();
    const money = tile("Pendiente de liquidar");
    expect(await within(money).findByText("$50.000")).toBeInTheDocument();
    expect(within(money).queryByText(/estimado/)).not.toBeInTheDocument();
  }, 20000);
});
