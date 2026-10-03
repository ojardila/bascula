// SPDX-License-Identifier: MIT
/**
 * The activity list's less travelled rows: an activity with no price of its
 * own on the day, one with an empty category, several dated prices, a refusal
 * from the server, and the dialog closing after a save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/node";
import { ActivitiesPage } from "./ActivitiesPage";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { api } from "../../api/endpoints";
import { theme } from "../../theme";
import { signInOwner } from "../../test/renderWithAuth";

vi.setConfig({ testTimeout: 30_000 });

function renderActivities() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/actividades"]}>
        <AuthProvider>
          <ActivitiesPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  signInOwner();
  invalidateRefs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NO_RATE = {
  id: "0192f3a0-aaaa-7000-8000-000000000001",
  name: "Guadañada sin precio",
  categoryId: "0192f3a0-aaaa-7000-8000-0000000000c1",
  category: "",
  payScheme: "tiempo",
  rateSource: "activity_dated",
  unitId: null,
  archivedAt: null,
};

describe("ActivitiesPage — rows without a price", () => {
  it("shows a dash for an activity with no price of its own, and opens it with an empty price box", async () => {
    server.use(
      http.get("*/v1/activities", () => HttpResponse.json({ items: [NO_RATE] })),
    );
    const user = userEvent.setup();
    renderActivities();
    const name = await screen.findByText("Guadañada sin precio");
    const row = name.closest("tr")!;
    expect(within(row).getByText("—")).toBeInTheDocument();

    await user.click(name);
    const dialog = await screen.findByRole("dialog");
    const price = within(dialog).getAllByRole("textbox").find((el) => (el as HTMLInputElement).value === "");
    expect(price).toBeDefined();
  });

  it("says how many dated prices an activity has when it has more than one", async () => {
    vi.spyOn(api, "listActivities").mockResolvedValue([
      {
        id: "a1",
        name: "Siembra con historial",
        category: "siembra",
        payMode: "contract",
        workUnit: null,
        timeUnit: null,
        customQty: null,
        customPeriod: null,
        rateSource: "fixed",
        defaultRateCents: 150_000,
        status: "active",
        rates: [
          { validFrom: "2026-01-01", rateCents: 100_000 },
          { validFrom: "2026-06-01", rateCents: 150_000 },
        ],
      },
      {
        id: "a2",
        name: "Siembra con un precio",
        category: "siembra",
        payMode: "contract",
        workUnit: null,
        timeUnit: null,
        customQty: null,
        customPeriod: null,
        rateSource: "fixed",
        defaultRateCents: 90_000,
        status: "active",
        rates: [{ validFrom: "2026-01-01", rateCents: 90_000 }],
      },
    ] as never);
    renderActivities();
    expect(await screen.findByText("2 precios con vigencia")).toBeInTheDocument();
    const single = screen.getByText("Siembra con un precio").closest("tr")!;
    expect(within(single).queryByText(/precios con vigencia/)).not.toBeInTheDocument();
  });
});

describe("ActivitiesPage — refusal and save", () => {
  it("says the person may not see the activities when the server refuses", async () => {
    server.use(
      http.get("*/v1/activities", () =>
        HttpResponse.json({ code: "FORBIDDEN", message: "no" }, { status: 403 }),
      ),
    );
    renderActivities();
    expect(
      await screen.findByText("No tiene permiso para ver las actividades"),
    ).toBeInTheDocument();
  });

  it("closes the dialog after saving a change", async () => {
    const user = userEvent.setup();
    renderActivities();
    await user.click(await screen.findByText("Recolección de café"));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Recolección de café")).toBeInTheDocument();
  });
});
