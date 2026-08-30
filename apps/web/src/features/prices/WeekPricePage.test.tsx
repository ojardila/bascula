/**
 * EL CAMPO QUE NO EXISTÍA.
 *
 * `PUT /v1/prices/weeks/{monday}` estaba en el cliente desde el sprint 1 y
 * ninguna pantalla lo llamaba: la consola sabía LEER el precio del kilo de la
 * semana y no sabía FIJARLO. Es la tarea más corriente del dueño de una finca
 * cafetera en cosecha, y era imposible desde aquí.
 *
 * Lo que se prueba, en este orden:
 *
 *   1. que el campo existe y que guardar llega al servidor;
 *   2. que antes de guardar se dice QUÉ se mueve — porque cambiar el precio
 *      de una semana reprecia toda su recolección sin liquidar;
 *   3. que el botón no escribe: abre la confirmación, y desde ahí se puede
 *      salir sin haber cambiado nada.
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
/** El pesador, que no decide lo que vale un kilo. */
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

describe("fijar el precio del kilo de la semana", () => {
  it("enseña lo que se está pagando hoy", async () => {
    renderPrices();
    // La finca sembrada paga $800 el kilo. Sale arriba en grande y otra vez en
    // la tabla de las últimas semanas, que es el historial.
    expect((await screen.findAllByText("$800")).length).toBeGreaterThan(0);
    expect(screen.getByText("por kilo")).toBeInTheDocument();
  }, 20000);

  it("guarda el precio nuevo, y sólo después de que alguien lo confirme", async () => {
    const user = userEvent.setup();
    renderPrices();
    await screen.findAllByText("$800");

    await user.type(screen.getByLabelText(/Precio nuevo por kilo/), "900");

    // «Revisar y fijar» no escribe nada: abre la lista de lo que se movería.
    await user.click(screen.getByRole("button", { name: /Revisar y fijar/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Estaba en/)).toBeInTheDocument();
    // Abrir el diálogo no escribe: la finca sigue en los $800 sembrados.
    expect(priceOf(thisMonday())).toBe(80_000);

    await user.click(within(dialog).getByRole("button", { name: /^Fijar en \$900$/ }));

    await waitFor(() => expect(priceOf(thisMonday())).toBe(90_000));
    expect(
      await screen.findByText(/La recolección de esa semana que todavía no se ha liquidado/),
    ).toBeInTheDocument();
  }, 20000);

  /**
   * La confirmación no es un «¿está seguro?». Dice cuánta recolección sin
   * liquidar cambia de valor y de cuánto a cuánto, que es lo que la persona
   * necesita para decidir. Es el mismo patrón de la nómina de cuadrilla.
   */
  it("dice qué se mueve antes de moverlo", async () => {
    const user = userEvent.setup();
    renderPrices();
    await screen.findAllByText("$800");

    // Lo que hay sin liquidar en la semana en curso, dicho fuera del diálogo.
    expect(
      await screen.findByText(/labores de recolección/, { exact: false }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Precio nuevo por kilo/), "1600");
    await user.click(screen.getByRole("button", { name: /Revisar y fijar/ }));

    const dialog = await screen.findByRole("dialog");
    // Al doble de precio, lo pendiente de la semana vale el doble, y la
    // diferencia se enseña con su signo.
    expect(within(dialog).getByText("Diferencia")).toBeInTheDocument();
    expect(within(dialog).getByText(/Con el precio nuevo/)).toBeInTheDocument();
    // Y lo que ya se liquidó no se toca: ése es el trato de liquidar.
    expect(within(dialog).getByText(/no se ha liquidado/)).toBeInTheDocument();
  }, 20000);

  it("«Ahora no» deja el precio como estaba", async () => {
    const user = userEvent.setup();
    renderPrices();
    await screen.findAllByText("$800");

    await user.type(screen.getByLabelText(/Precio nuevo por kilo/), "900");
    await user.click(screen.getByRole("button", { name: /Revisar y fijar/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Ahora no" }));

    expect(priceOf(thisMonday())).toBe(80_000);
  }, 20000);

  it("no acepta un precio que no es un precio", async () => {
    const user = userEvent.setup();
    renderPrices();
    await screen.findAllByText("$800");

    await user.type(screen.getByLabelText(/Precio nuevo por kilo/), "abc");
    await user.click(screen.getByRole("button", { name: /Revisar y fijar/ }));

    expect(await screen.findByText(/Escriba el precio en pesos/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  }, 20000);

  /** `config.prices` es del dueño. Un pesador no decide lo que vale un kilo. */
  it("el pesador no entra", async () => {
    signIn(WEIGHER);
    renderPrices();
    expect(
      await screen.findByText(/No tiene permiso para (ver|fijar) el precio de la semana/),
    ).toBeInTheDocument();
  }, 20000);
});
