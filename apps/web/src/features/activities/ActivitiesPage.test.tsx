/**
 * ── THE "PRECIO FIJO" TRAP ───────────────────────────────────────────────
 *
 * Nowhere in the whole console could you set the week's price per kilo. An
 * owner looking for it landed here, hit "Precio fijo" — because that is where
 * a price box does appear — typed 900, saved, and walked away believing they
 * had raised the week's price.
 *
 * What that switch actually did was change the PAY MODE for all of the farm's
 * coffee picking and cut it loose from the weekly price the phone still uses.
 * And on an activity that already exists it did not even do that:
 * `api.updateActivity` only sends name and category, so the switch moved on
 * screen and changed nothing on the server — which is worse, because the
 * person leaves convinced they changed something.
 *
 * These tests pin down both halves of the fix: the lock with its explanation,
 * and the sign that says where the price per kilo really lives.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { ActivitiesPage } from "./ActivitiesPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

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
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

describe("the activity list", () => {
  it("says where the price per kilo lives, right where people came looking for it", async () => {
    renderActivities();
    await screen.findByText("Recolección de café");
    expect(
      screen.getByText(/no se pone aquí: se pone semana por semana/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Precio del kilo" })).toHaveAttribute(
      "href",
      "/precio-semana",
    );
  }, 20000);

  /** "Unidad de trabajo" is a column name. On the farm it is piece rate. */
  it("names the pay modes the way the farm names them", async () => {
    renderActivities();
    await screen.findByText("Recolección de café");
    expect(screen.getAllByText("A destajo").length).toBeGreaterThan(0);
    expect(screen.queryByText("Unidad de trabajo")).not.toBeInTheDocument();
  }, 20000);
});

describe("editing an activity that already exists", () => {
  async function openPicking(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByText("Recolección de café");
    await user.click(screen.getByText("Recolección de café"));
    return screen.findByRole("dialog");
  }

  it("will not let the switch that decides how the work is paid be moved", async () => {
    const user = userEvent.setup();
    renderActivities();
    const dialog = await openPicking(user);

    // This farm's picking is paid at the week's price.
    const weekly = within(dialog).getByRole("button", {
      name: "Lo pone el precio de la semana",
    });
    expect(weekly).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Precio fijo de esta actividad" }),
    ).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: /A destajo/ })).toBeDisabled();
  }, 20000);

  it("and explains why, instead of leaving it mute", async () => {
    const user = userEvent.setup();
    renderActivities();
    const dialog = await openPicking(user);
    expect(
      within(dialog).getByText(/las labores ya registradas quedaron pagadas con esas reglas/),
    ).toBeInTheDocument();
  }, 20000);

  it("sends you to the place where the price per kilo really is changed", async () => {
    const user = userEvent.setup();
    renderActivities();
    const dialog = await openPicking(user);
    expect(
      within(dialog).getByText(/Aquí no se cambia el precio del kilo/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Precio del kilo" })).toHaveAttribute(
      "href",
      "/precio-semana",
    );
  }, 20000);
});

describe("creating a new activity", () => {
  /**
   * Here the switch CAN be moved, because no work item has been paid under
   * those rules yet. And this is exactly where the warning is needed.
   */
  it("warns, for real, about what a fixed price does to coffee picking", async () => {
    const user = userEvent.setup();
    renderActivities();
    await screen.findByText("Recolección de café");
    await user.click(screen.getByRole("button", { name: /Nueva actividad/ }));
    const dialog = await screen.findByRole("dialog");

    // A new activity is born on a fixed price, which is the warning in place.
    expect(
      within(dialog).getByText(/Este precio no es el del kilo de la semana/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/deja de seguir el precio semanal/),
    ).toBeInTheDocument();

    // And once the week's price is chosen the warning is moot and goes away.
    await user.click(
      within(dialog).getByRole("button", { name: "Lo pone el precio de la semana" }),
    );
    expect(
      within(dialog).queryByText(/Este precio no es el del kilo de la semana/),
    ).not.toBeInTheDocument();
  }, 20000);
});
