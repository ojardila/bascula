// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/node";
import { ActivityFormDialog } from "./ActivityFormDialog";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { api } from "../../api/endpoints";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import type { Activity } from "../../api/types";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

function open(activity: Activity | null, canSetRate = true) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <ActivityFormDialog
            open
            activity={activity}
            canSetRate={canSetRate}
            knownCategories={["Beneficio"]}
            onClose={onClose}
            onSaved={onSaved}
          />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
  return { onSaved, onClose };
}

async function activityNamed(name: string): Promise<Activity> {
  const all = await api.listActivities();
  const found = all.find((a) => a.name === name);
  if (!found) throw new Error(`no activity ${name}`);
  return found;
}

/** Records every request body sent to a path, so a test can see what was saved. */
function captureBodies(method: string, pathEnd: RegExp) {
  const bodies: Record<string, unknown>[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (
      request.method === method &&
      pathEnd.test(new URL(request.url).pathname)
    ) {
      bodies.push((await request.clone().json()) as Record<string, unknown>);
    }
  });
  return bodies;
}

describe("ActivityFormDialog — a new activity", () => {
  beforeEach(() => server.events.removeAllListeners());

  it("validates the name, the category and the price", async () => {
    const user = userEvent.setup();
    const { onSaved } = open(null);
    const dialog = await screen.findByRole("dialog");
    await user.clear(within(dialog).getByLabelText("Categoría"));
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    expect(
      await within(dialog).findByText("Escriba el nombre de la actividad."),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Escriba el precio.")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/^Precio por kg/), "0");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    expect(
      await within(dialog).findByText(
        "El precio tiene que ser mayor que cero.",
      ),
    ).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("creates a piece-rate activity with a fixed price in another unit", async () => {
    const user = userEvent.setup();
    const bodies = captureBodies("POST", /\/v1\/activities$/);
    const { onSaved } = open(null);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Este precio no es el del kilo de la semana/),
    ).toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText(/^Nombre/),
      "Recolección de mora",
    );
    await user.click(within(dialog).getByRole("combobox", { name: "Unidad" }));
    await user.click(await screen.findByRole("option", { name: "canasta" }));
    await user.type(
      within(dialog).getByLabelText(/^Precio por canasta/),
      "3500",
    );
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(bodies[0]).toMatchObject({ name: "Recolección de mora" });
  });

  it("creates a piece-rate activity that takes the week's price", async () => {
    const user = userEvent.setup();
    const { onSaved } = open(null);
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText(/^Nombre/),
      "Recolección de pasilla",
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "Lo pone el precio de la semana",
      }),
    );
    expect(
      within(dialog).getByText(/Aquí no se cambia el precio del kilo/),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText(/^Precio por/),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("creates a day-rate activity with a typed category", async () => {
    const user = userEvent.setup();
    const { onSaved } = open(null);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Nombre/), "Desyerba");
    const category = within(dialog).getByLabelText("Categoría");
    await user.clear(category);
    await user.type(category, "Mantenimiento");
    await user.click(
      within(dialog).getByRole("button", { name: "Al jornal · por día" }),
    );
    expect(
      within(dialog).queryByText("De dónde sale el precio"),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("combobox", { name: "Período" }));
    await user.click(await screen.findByRole("option", { name: "Mensual" }));
    await user.type(within(dialog).getByLabelText(/^Precio por/), "1500000");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("creates a contract and shows a refusal from the server", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/v1/activities", () =>
        HttpResponse.json(
          { error: { code: "DUPLICATE_NAME", message: "dup", details: {} } },
          { status: 409 },
        ),
      ),
    );
    const { onSaved, onClose } = open(null);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Nombre/), "Zoqueo");
    await user.click(
      within(dialog).getByRole("button", { name: "Por contrato" }),
    );
    await user.type(
      within(dialog).getByLabelText(/^Valor del contrato/),
      "650000",
    );
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ActivityFormDialog — an existing activity", () => {
  beforeEach(() => server.events.removeAllListeners());

  it("locks the pay mode and saves a changed price as a new period", async () => {
    const user = userEvent.setup();
    const guadanada = await activityNamed("Guadañada");
    const rates = captureBodies("PUT", /\/v1\/activities\/[^/]+\/rate$/);
    const { onSaved } = open(guadanada);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByDisplayValue("Guadañada")).toBeInTheDocument();
    expect(within(dialog).getByText(/no se cambian/)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Al jornal · por día" }),
    ).toBeDisabled();
    const price = within(dialog).getByLabelText(/^Precio por/);
    await user.clear(price);
    await user.type(price, "50000");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(rates).toHaveLength(1);
  });

  it("only renames when the price is unchanged", async () => {
    const user = userEvent.setup();
    const siembra = await activityNamed("Siembra de colinos");
    const rates = captureBodies("PUT", /\/v1\/activities\/[^/]+\/rate$/);
    const { onSaved } = open(siembra);
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText(/^Nombre/);
    await user.clear(name);
    await user.type(name, "Siembra de colinos nuevos");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(rates).toHaveLength(0);
  });

  it("keeps the price box read-only for somebody who may not set rates", async () => {
    const user = userEvent.setup();
    const coffee = await activityNamed("Recolección de aguacate");
    const { onSaved } = open(coffee, false);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/^Precio por/)).toBeDisabled();
    expect(
      within(dialog).queryByLabelText(/Precio vigente desde/),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("shows a weekly-priced activity without a price box", async () => {
    const coffee = await activityNamed("Recolección de café");
    open(coffee);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Aquí no se cambia el precio del kilo/),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText(/^Precio por/),
    ).not.toBeInTheDocument();
  });
});
