/**
 * ── LA TRAMPA DEL «PRECIO FIJO» ──────────────────────────────────────────
 *
 * No había en toda la consola dónde poner el precio del kilo de la semana. Un
 * dueño que lo buscaba llegaba aquí, pulsaba «Precio fijo» —porque ahí sí
 * aparece una casilla de precio—, escribía 900, guardaba, y se iba creyendo
 * que había subido el precio de la semana.
 *
 * Lo que en realidad hacía ese interruptor era cambiar la FORMA DE PAGO de
 * toda la recolección de la finca y desconectarla del precio semanal que el
 * teléfono sigue usando. Y sobre una actividad que ya existe no hacía ni eso:
 * `api.updateActivity` sólo manda nombre y categoría, así que el interruptor
 * se movía en pantalla y no cambiaba nada en el servidor — que es peor,
 * porque la persona se va convencida de haber cambiado algo.
 *
 * Estas pruebas fijan las dos mitades del arreglo: el candado con su
 * explicación, y el letrero que dice dónde está de verdad el precio del kilo.
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

describe("la lista de actividades", () => {
  it("dice, donde la gente vino a buscarlo, dónde está el precio del kilo", async () => {
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

  /** «Unidad de trabajo» es el nombre de una columna. En la finca es destajo. */
  it("nombra las formas de pago como se nombran en la finca", async () => {
    renderActivities();
    await screen.findByText("Recolección de café");
    expect(screen.getAllByText("A destajo").length).toBeGreaterThan(0);
    expect(screen.queryByText("Unidad de trabajo")).not.toBeInTheDocument();
  }, 20000);
});

describe("modificar una actividad que ya existe", () => {
  async function openRecoleccion(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByText("Recolección de café");
    await user.click(screen.getByText("Recolección de café"));
    return screen.findByRole("dialog");
  }

  it("no deja mover el interruptor que decide cómo se paga", async () => {
    const user = userEvent.setup();
    renderActivities();
    const dialog = await openRecoleccion(user);

    // La recolección de esta finca se paga al precio de la semana.
    const weekly = within(dialog).getByRole("button", {
      name: "Lo pone el precio de la semana",
    });
    expect(weekly).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Precio fijo de esta actividad" }),
    ).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: /A destajo/ })).toBeDisabled();
  }, 20000);

  it("y explica por qué, en vez de dejarlo mudo", async () => {
    const user = userEvent.setup();
    renderActivities();
    const dialog = await openRecoleccion(user);
    expect(
      within(dialog).getByText(/las labores ya registradas quedaron pagadas con esas reglas/),
    ).toBeInTheDocument();
  }, 20000);

  it("manda al sitio donde sí se cambia el precio del kilo", async () => {
    const user = userEvent.setup();
    renderActivities();
    const dialog = await openRecoleccion(user);
    expect(
      within(dialog).getByText(/Aquí no se cambia el precio del kilo/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Precio del kilo" })).toHaveAttribute(
      "href",
      "/precio-semana",
    );
  }, 20000);
});

describe("crear una actividad nueva", () => {
  /**
   * Aquí el interruptor SÍ se puede mover, porque todavía no hay ninguna labor
   * pagada con esas reglas. Y es justo donde hace falta el aviso.
   */
  it("avisa, en serio, de lo que hace «precio fijo» en la recolección", async () => {
    const user = userEvent.setup();
    renderActivities();
    await screen.findByText("Recolección de café");
    await user.click(screen.getByRole("button", { name: /Nueva actividad/ }));
    const dialog = await screen.findByRole("dialog");

    // Una actividad nueva nace con precio fijo, que es el aviso puesto.
    expect(
      within(dialog).getByText(/Este precio no es el del kilo de la semana/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/deja de seguir el precio semanal/),
    ).toBeInTheDocument();

    // Y al elegir el precio de la semana, el aviso sobra y se va.
    await user.click(
      within(dialog).getByRole("button", { name: "Lo pone el precio de la semana" }),
    );
    expect(
      within(dialog).queryByText(/Este precio no es el del kilo de la semana/),
    ).not.toBeInTheDocument();
  }, 20000);
});
