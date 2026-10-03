/**
 * The one-person weighing screen online: what it asks for, the doubt about a
 * sack too heavy for one person, teams weighed as one, undoing, and the
 * failures on the way in.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { api } from "../../api/endpoints";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const JHON = "0192f3a0-0006-7000-8000-000000000002";
const LUZ = "0192f3a0-0006-7000-8000-000000000003";

function renderWeighing() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/cosecha/recoleccion?quien=uno"]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  localStorage.clear();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

type User = ReturnType<typeof userEvent.setup>;

async function pickPerson(user: User, name: RegExp) {
  await user.click(await screen.findByLabelText(/^Persona/));
  await user.click(await screen.findByRole("option", { name }));
}

async function save(user: User) {
  await user.click(screen.getByRole("button", { name: "Guardar pesada" }));
}

describe("the weighing form", () => {
  it("asks for the person, the lote and the kilos, in that order", async () => {
    const user = userEvent.setup();
    renderWeighing();
    await screen.findByLabelText(/^Persona/);
    await save(user);
    expect(await screen.findByText("Elija a la persona.")).toBeInTheDocument();
    await pickPerson(user, /María Restrepo Ospina/);
    await save(user);
    expect(await screen.findByText("Elija el lote.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "El Alto" }));
    await save(user);
    expect(await screen.findByText("Escriba los kilos.")).toBeInTheDocument();
    const alert = screen
      .getByText("Escriba los kilos.")
      .closest('[role="alert"]') as HTMLElement;
    await user.click(within(alert).getByRole("button"));
    expect(screen.queryByText("Escriba los kilos.")).not.toBeInTheDocument();
  }, 20000);

  it("saves a weighing for yesterday, lists it and undoes it", async () => {
    const user = userEvent.setup();
    renderWeighing();
    await pickPerson(user, /María Restrepo Ospina/);
    expect(screen.getAllByText(/María Restrepo Ospina/).length).toBeGreaterThan(
      0,
    );
    await user.click(screen.getByRole("button", { name: "El Alto" }));
    await user.click(screen.getByRole("button", { name: "Otro día" }));
    expect(screen.getByLabelText("Fecha")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ayer" }));
    expect(screen.queryByLabelText("Fecha")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Kilos"), "37{Enter}");
    expect(
      await screen.findByText(/Guardado: María Restrepo Ospina, 37 kg/),
    ).toBeInTheDocument();
    expect(screen.getByText("Guardadas en esta pantalla")).toBeInTheDocument();
    expect(
      localStorage.getItem(`bascula.pesada.lote:${db.FARM_ID}`),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Deshacer" }));
    expect(
      await screen.findByText(
        "Se borró la pesada de María Restrepo Ospina: 37 kg.",
      ),
    ).toBeInTheDocument();
  }, 20000);

  it("doubts a sack heavier than one person carries", async () => {
    const user = userEvent.setup();
    renderWeighing();
    await pickPerson(user, /María Restrepo Ospina/);
    await user.click(screen.getByRole("button", { name: "La Cuchilla" }));
    await user.type(screen.getByLabelText("Kilos"), "150");
    await save(user);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("¿150 kg en una sola pesada?"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Es más de lo que carga una persona/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Corregir" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    await save(user);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Sí, guardar",
      }),
    );
    expect(
      await screen.findByText(/Guardado: María Restrepo Ospina, 150 kg/),
    ).toBeInTheDocument();
  }, 20000);

  it("remembers the lote weighed last on this phone", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      `bascula.pesada.lote:${db.FARM_ID}`,
      db.tenantOf(db.FARM_ID)!.plots.find((p) => p.name === "Bajo del Río")!.id,
    );
    renderWeighing();
    await pickPerson(user, /Luz Dary/);
    expect(
      await screen.findByRole("button", {
        name: "Bajo del Río",
        pressed: true,
      }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Kilos"), "12");
    await save(user);
    expect(
      await screen.findByText(/Guardado: Luz Dary .*, 12 kg/),
    ).toBeInTheDocument();
  }, 20000);

  it("weighs a team as one and spreads the kilos for the averages", async () => {
    const user = userEvent.setup();
    await api.createWorker({
      id: "0192f3a0-0006-7000-8000-0000000000aa",
      name: "Los Primos",
      tag: "40",
      kind: "equipo",
      memberIds: [JHON, LUZ],
    } as Parameters<typeof api.createWorker>[0]);
    invalidateRefs();
    renderWeighing();
    // Picking a member picks the team.
    await user.click(await screen.findByLabelText(/^Persona/));
    await screen.findAllByRole("option");
    const member = screen
      .getAllByRole("option", { name: /Jhon Fredy/ })
      .find(
        (o) =>
          !o.textContent?.includes("Los Primos ·") &&
          o.textContent?.includes("Pesa con"),
      );
    expect(member).toBeDefined();
    await user.click(member!);
    expect(
      await screen.findByText(/Se pesa todo junto, a nombre del equipo/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "El Alto" }));
    await user.type(screen.getByLabelText("Kilos"), "50");
    expect(screen.getByText(/25 kg por persona/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Kilos"));
    await user.type(screen.getByLabelText("Kilos"), "300");
    await save(user);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Es más de lo que cargan 2 personas/),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Sí, guardar" }),
    );
    expect(
      await screen.findByText(/Guardado: Los Primos, 300 kg/),
    ).toBeInTheDocument();
  }, 20000);

  it("shows the server's refusal and keeps what was typed", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/v1/work-records", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no", details: {} } },
          { status: 403 },
        ),
      ),
    );
    renderWeighing();
    await pickPerson(user, /María Restrepo Ospina/);
    await user.click(screen.getByRole("button", { name: "El Alto" }));
    await user.type(screen.getByLabelText("Kilos"), "20");
    await save(user);
    expect(await screen.findByText(/no tiene permiso/)).toBeInTheDocument();
    expect(screen.getByLabelText("Kilos")).toHaveValue("20");
  }, 20000);

  it("says when the farm has no harvest activity", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/v1/activities", () => HttpResponse.json({ items: [] })),
    );
    renderWeighing();
    await pickPerson(user, /María Restrepo Ospina/);
    await user.click(screen.getByRole("button", { name: "El Alto" }));
    await user.type(screen.getByLabelText("Kilos"), "20");
    await save(user);
    expect(
      await screen.findByText(/La finca no tiene una actividad de recolección/),
    ).toBeInTheDocument();
  }, 20000);
});

describe("loading the lists", () => {
  it("shows a server error that is not a lost signal", async () => {
    server.use(
      http.get("*/v1/plots", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no", details: {} } },
          { status: 403 },
        ),
      ),
    );
    renderWeighing();
    expect(await screen.findByText(/no tiene permiso/)).toBeInTheDocument();
  }, 20000);

  it("says there is nothing saved to work from without signal", async () => {
    server.use(http.get("*/v1/plots", () => HttpResponse.error()));
    renderWeighing();
    expect(
      await screen.findByText(/Sin señal y sin lista guardada/),
    ).toBeInTheDocument();
  }, 20000);
});
