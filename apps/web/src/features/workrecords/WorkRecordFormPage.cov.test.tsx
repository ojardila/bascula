// SPDX-License-Identifier: MIT
/**
 * «Registrar labor», the paths the main suites leave out: the two date fields
 * and how they drag each other, a week price fetched for an old date, a farm
 * with no kilo price at all, an activity with no default price, a worker with
 * no document, the administrator who cannot change a price, a form that does
 * not validate, a server that fails without saying which field, and a device
 * whose storage will not open while there is no signal.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { WorkRecordFormPage } from "./WorkRecordFormPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { server } from "../../mocks/node";
import { resetStoreForTests } from "../../offline/store";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const ADMIN = "0192f3a0-0001-7000-8000-000000000002";
const tenant = () => db.tenantOf(db.FARM_ID)!;

function signIn(userId: string) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
}

function renderForm() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/labores/nueva"]}>
        <AuthProvider>
          <Routes>
            <Route path="/labores/nueva" element={<WorkRecordFormPage />} />
            <Route path="/labores" element={<div>lista de labores</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  signIn(OWNER);
});

type User = ReturnType<typeof userEvent.setup>;

async function pickActivity(user: User, name: string) {
  await user.click(await screen.findByLabelText(/^Actividad/));
  await user.click(await screen.findByRole("option", { name }));
}

const fecha = () => screen.getByRole("textbox", { name: /^Fecha/ });
const hasta = () => screen.getByRole("textbox", { name: /^Hasta/ });

async function typeDate(user: User, field: HTMLElement, text: string) {
  await user.clear(field);
  if (text) await user.type(field, text);
}

describe("the two dates", () => {
  it("drags «Hasta» forward with «Fecha», never back, and lets it be changed", async () => {
    const user = userEvent.setup();
    renderForm();
    await screen.findByLabelText(/^Actividad/);
    // No activity yet: «Hasta» is closed and «Fecha» still takes a day.
    expect(hasta()).toBeDisabled();
    await typeDate(user, fecha(), "01/09/2026");
    expect(fecha()).toHaveValue("01/09/2026");

    await pickActivity(user, "Guadañada");
    await waitFor(() => expect(hasta()).toBeEnabled());
    const before = (hasta() as HTMLInputElement).value;
    // An earlier «Fecha» leaves «Hasta» where it was.
    await typeDate(user, fecha(), "02/09/2026");
    expect(hasta()).toHaveValue(before);
    // A «Fecha» past «Hasta» drags it along.
    await typeDate(user, fecha(), "15/12/2026");
    await waitFor(() => expect(hasta()).toHaveValue("15/12/2026"));
    await typeDate(user, hasta(), "20/12/2026");
    expect(hasta()).toHaveValue("20/12/2026");

    // An empty «Fecha» leaves «Hasta» with no lower bound.
    await typeDate(user, fecha(), "");
    expect(fecha()).toHaveValue("");
    expect(hasta()).toHaveValue("20/12/2026");
  }, 30000);

  it("keeps one day for the kilo price, and names this week while the date is empty", async () => {
    const user = userEvent.setup();
    renderForm();
    await pickActivity(user, "Recolección de café");
    expect(
      await screen.findByText("Un solo día: precio semanal."),
    ).toBeInTheDocument();
    await typeDate(user, fecha(), "02/09/2026");
    await waitFor(() => expect(hasta()).toHaveValue("02/09/2026"));
    expect(hasta()).toBeDisabled();

    await typeDate(user, fecha(), "");
    expect(
      screen.getByText(/Precio del kilo, semana del/),
    ).toBeInTheDocument();
  }, 30000);
});

describe("the kilo price", () => {
  it("asks for the price of a week older than the ones kept, once", async () => {
    tenant().weekPrices.push({ weekStart: "2026-03-02", priceCents: 123_400 });
    const asked: string[] = [];
    server.events.on("request:start", ({ request }) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/prices/weeks/2026-03-02")) asked.push(path);
    });
    const user = userEvent.setup();
    renderForm();
    await pickActivity(user, "Recolección de café");
    await typeDate(user, fecha(), "04/03/2026");
    await waitFor(() =>
      expect(screen.getByText(/Precio del kilo, semana del/)).toHaveTextContent(
        "$1.234",
      ),
    );
    expect(asked).toHaveLength(1);
    server.events.removeAllListeners();
  }, 30000);

  it("says «—» when the farm has no kilo price anywhere", async () => {
    const t = tenant();
    t.basePrices = [];
    t.specialPrices = [];
    t.weekPrices = [];
    db.farmOf(db.FARM_ID)!.priceCents = 0;
    const user = userEvent.setup();
    renderForm();
    await pickActivity(user, "Recolección de café");
    await waitFor(() =>
      expect(screen.getByText(/Precio del kilo, semana del/)).toHaveTextContent(
        /: — \//,
      ),
    );
  }, 30000);
});

describe("the price field", () => {
  it("starts empty when the activity has no price of its own", async () => {
    const contract = tenant().activities.find(
      (a) => a.name === "Siembra de colinos",
    )!;
    contract.rates = [];
    const user = userEvent.setup();
    renderForm();
    await pickActivity(user, "Siembra de colinos");
    expect(await screen.findByLabelText(/^Valor del contrato/)).toHaveValue("");
  }, 30000);

  it("is closed to the administrator, and says only the owner changes it", async () => {
    signIn(ADMIN);
    const user = userEvent.setup();
    renderForm();
    await pickActivity(user, "Siembra de colinos");
    expect(await screen.findByLabelText(/^Valor del contrato/)).toBeDisabled();
    expect(
      screen.getByText("Solo el dueño puede cambiarlo."),
    ).toBeInTheDocument();
  }, 30000);
});

describe("the employee picker", () => {
  it("names a person with no document by name alone, and can be emptied", async () => {
    const [first] = tenant().workers;
    (first as { docId: string | null }).docId = null;
    const full = `${first.name} ${first.lastName}`;
    const user = userEvent.setup();
    renderForm();
    await screen.findByLabelText(/^Actividad/);
    await user.click(screen.getByLabelText(/^Empleado/));
    await user.click(await screen.findByRole("option", { name: full }));
    expect(screen.getByLabelText(/^Empleado/)).toHaveValue(full);

    await user.clear(screen.getByLabelText(/^Empleado/));
    expect(screen.getByLabelText(/^Empleado/)).toHaveValue("");
  }, 30000);
});

describe("saving", () => {
  it("does not send a form that does not validate", async () => {
    const posted: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "POST") posted.push(request.url);
    });
    const user = userEvent.setup();
    renderForm();
    await screen.findByLabelText(/^Actividad/);
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(screen.getByLabelText(/^Actividad/)).toHaveAttribute(
        "aria-invalid",
        "true",
      ),
    );
    expect(posted).toEqual([]);
    expect(screen.queryByText("lista de labores")).not.toBeInTheDocument();
    server.events.removeAllListeners();
  }, 30000);

  it("drops the crops of a lote taken out, and says why a failed save failed", async () => {
    let body: { plotIds: string[]; plotCropIds: string[] } | null = null;
    server.use(
      http.post("*/v1/work-records", async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom" } },
          { status: 500 },
        );
      }),
    );
    const user = userEvent.setup();
    renderForm();
    await pickActivity(user, "Guadañada");
    await user.click(screen.getByLabelText(/^Empleado/));
    await user.click(await screen.findByRole("option", { name: /María/ }));

    const lotes = ["El Alto", "La Cuchilla", "Bajo del Río"];
    for (const l of lotes) {
      await user.click(screen.getByLabelText(/^Lotes/));
      await user.click(await screen.findByRole("option", { name: l }));
      await user.keyboard("{Escape}");
    }

    for (const l of lotes) {
      await user.click(screen.getByLabelText(/^Cultivos/));
      const crops = await screen.findAllByRole("option", {
        name: (name) => name.startsWith(`${l} · `),
      });
      await user.click(crops[0]);
      await user.keyboard("{Escape}");
    }

    // Bajo del Río leaves, and its crop with it.
    await user.click(screen.getByLabelText(/^Lotes/));
    await user.click(await screen.findByRole("option", { name: "Bajo del Río" }));
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("button", { name: /^Bajo del Río · / }),
    ).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Jornales|^Días|^Horas|^Cantidad/), "2");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("lista de labores")).not.toBeInTheDocument();
    expect(body!.plotIds).toHaveLength(2);
    expect(body!.plotCropIds).toHaveLength(2);
    const bajo = tenant().plots.find((p) => p.name === "Bajo del Río")!;
    expect(body!.plotIds).not.toContain(bajo.id);
  }, 40000);
});

describe("with no signal and no storage", () => {
  it("says what failed instead of opening an empty form", async () => {
    server.use(
      http.get("*/v1/workers", () => HttpResponse.error()),
      http.get("*/v1/plots", () => HttpResponse.error()),
      http.get("*/v1/activities", () => HttpResponse.error()),
      http.get("*/v1/prices/*", () => HttpResponse.error()),
    );
    // The browser refuses to open the device's storage.
    globalThis.indexedDB = {
      open: () => {
        throw new Error("storage refused");
      },
    } as unknown as IDBFactory;
    resetStoreForTests();
    renderForm();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Registrar labor" })).toBeInTheDocument();
  }, 30000);
});
