/**
 * THE FIELD THAT DID NOT EXIST.
 *
 * `PUT /v1/prices/weeks/{monday}` had been in the client since sprint 1 and no
 * screen called it: the console knew how to READ the week's price per kilo and
 * did not know how to SET it. It is the most ordinary task a coffee farm owner
 * has during harvest, and from here it was impossible.
 *
 * What is tested, in this order:
 *
 *   1. that the field exists and that saving reaches the server;
 *   2. that before saving it says WHAT moves — because changing a week's price
 *      reprices all of that week's unsettled picking;
 *   3. that the button does not write: it opens the confirmation, and you can
 *      leave from there without having changed anything.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { WeekPricePage } from "./WeekPricePage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { mondayOf, todayInFarm } from "../../lib/dates";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
/** The weigher, who does not decide what a kilo is worth. */
const WEIGHER = "0192f3a0-0001-7000-8000-000000000003";

function renderPrices() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/precio-semana"]}>
        <AuthProvider>
          <WeekPricePage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function signIn(userId: string) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
}

const thisMonday = () => mondayOf(todayInFarm("America/Bogota"));

const priceOf = (monday: string) =>
  db.tenantOf(db.FARM_ID)!.weekPrices.find((p) => p.weekStart === monday)?.priceCents ?? null;

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  signIn(OWNER);
});

describe("setting the week's price per kilo", () => {
  it("shows what is being paid today", async () => {
    renderPrices();
    // The seeded farm pays $800 a kilo. It shows large at the top and again in
    // the table of recent weeks, which is the history.
    expect((await screen.findAllByText("$800")).length).toBeGreaterThan(0);
    expect(screen.getByText("por kilo")).toBeInTheDocument();
  }, 20000);

  it("saves the new price, and only after somebody confirms it", async () => {
    const user = userEvent.setup();
    renderPrices();
    await screen.findAllByText("$800");

    await user.type(screen.getByLabelText(/Precio nuevo por kilo/), "900");

    // "Revisar y fijar" writes nothing: it opens the list of what would move.
    await user.click(screen.getByRole("button", { name: /Revisar y fijar/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Estaba en/)).toBeInTheDocument();
    // Opening the dialog does not write: the farm is still on the seeded $800.
    expect(priceOf(thisMonday())).toBe(80_000);

    await user.click(within(dialog).getByRole("button", { name: /^Fijar en \$900$/ }));

    await waitFor(() => expect(priceOf(thisMonday())).toBe(90_000));
    expect(
      await screen.findByText(/La recolección de esa semana que todavía no se ha liquidado/),
    ).toBeInTheDocument();
  }, 20000);

  /**
   * The confirmation is not an "are you sure?". It says how much unsettled
   * picking changes value and from how much to how much, which is what the
   * person needs in order to decide. Same pattern as the crew payroll.
   */
  it("says what moves before it moves it", async () => {
    const user = userEvent.setup();
    renderPrices();
    await screen.findAllByText("$800");

    // What is unsettled in the current week, said outside the dialog.
    expect(
      await screen.findByText(/labores de recolección/, { exact: false }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Precio nuevo por kilo/), "1600");
    await user.click(screen.getByRole("button", { name: /Revisar y fijar/ }));

    const dialog = await screen.findByRole("dialog");
    // At double the price, the week's outstanding work is worth double, and
    // the difference is shown with its sign.
    expect(within(dialog).getByText("Diferencia")).toBeInTheDocument();
    expect(within(dialog).getByText(/Con el precio nuevo/)).toBeInTheDocument();
    // And what is already settled is not touched: that is the deal of settling.
    expect(within(dialog).getByText(/no se ha liquidado/)).toBeInTheDocument();
  }, 20000);

  it('"Ahora no" leaves the price as it was', async () => {
    const user = userEvent.setup();
    renderPrices();
    await screen.findAllByText("$800");

    await user.type(screen.getByLabelText(/Precio nuevo por kilo/), "900");
    await user.click(screen.getByRole("button", { name: /Revisar y fijar/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Ahora no" }));

    expect(priceOf(thisMonday())).toBe(80_000);
  }, 20000);

  it("does not accept a price that is not a price", async () => {
    const user = userEvent.setup();
    renderPrices();
    await screen.findAllByText("$800");

    await user.type(screen.getByLabelText(/Precio nuevo por kilo/), "abc");
    await user.click(screen.getByRole("button", { name: /Revisar y fijar/ }));

    expect(await screen.findByText(/Escriba el precio en pesos/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  }, 20000);

  /** `config.prices` is the owner's. A weigher does not price a kilo. */
  it("the weigher does not get in", async () => {
    signIn(WEIGHER);
    renderPrices();
    expect(
      await screen.findByText(/No tiene permiso para (ver|fijar) el precio de la semana/),
    ).toBeInTheDocument();
  }, 20000);
});
