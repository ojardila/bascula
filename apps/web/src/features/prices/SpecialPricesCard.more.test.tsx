// SPDX-License-Identifier: MIT
/**
 * Special kilo prices, the parts the first file leaves out: a price for a
 * person, the checks before saving, changing an existing price, what the
 * dialog says it will move, the history, and the server saying no.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { SpecialPricesCard } from "./SpecialPricesCard";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const tenant = () => db.tenantOf(db.FARM_ID)!;

function renderCard() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <SpecialPricesCard canEdit />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const boom = () =>
  HttpResponse.json(
    { error: { code: "INTERNAL", message: "boom" } },
    { status: 500 },
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

describe("a price for one person", () => {
  it("checks the person and the amount before saving, then says what it did", async () => {
    const worker = tenant().workers.find(
      (w) => w.deletedAt == null && w.kind !== "equipo",
    )!;
    const name = `${worker.name} ${worker.lastName ?? ""}`.trim();
    const user = userEvent.setup();
    renderCard();
    await user.click(
      await screen.findByRole("button", {
        name: "Precio especial para una persona",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", {
      name: "Guardar precio especial",
    });

    await user.click(save);
    expect(
      await within(dialog).findByText("Escoja la persona."),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByLabelText("¿Qué persona?"));
    await user.click(await screen.findByRole("option", { name }));
    await user.click(save);
    expect(
      await within(dialog).findByText(
        "Escriba el precio en pesos. Por ejemplo: 1.000",
      ),
    ).toBeInTheDocument();

    const price = within(dialog).getByLabelText(
      "Precio especial por kilo en pesos",
    );
    await user.type(price, "50");
    await user.click(save);
    expect(await within(dialog).findByText(/es muy poco/)).toBeInTheDocument();

    await user.clear(price);
    await user.type(price, "1300");
    await user.click(save);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(tenant().specialPrices?.[0]).toMatchObject({
      kind: "persona",
      targetId: worker.id,
      priceCents: 130_000,
    });
    const done = await screen.findByText(/se paga a .* por kilo desde el/);
    const alert = done.closest(".MuiAlert-root") as HTMLElement;
    await user.click(
      within(alert).getByRole("button", { name: /close|cerrar/i }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(/se paga a .* por kilo desde el/),
      ).not.toBeInTheDocument(),
    );
  }, 30000);

  it("switching between lote and person empties the choice; Cancelar closes", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(
      await screen.findByRole("button", {
        name: "Precio especial para un lote",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("¿Qué lote?")).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Una persona" }),
    );
    expect(within(dialog).getByLabelText("¿Qué persona?")).toBeInTheDocument();
    // Pressing the one already chosen does not unselect it.
    await user.click(
      within(dialog).getByRole("button", { name: "Una persona" }),
    );
    expect(within(dialog).getByLabelText("¿Qué persona?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  }, 30000);
});

describe("what the dialog says it will move", () => {
  it("counts the open, settled and overridden weighings", async () => {
    server.use(
      http.get("*/v1/prices/special/:kind/:id/:monday/impact", () =>
        HttpResponse.json({
          unsettledRecords: 3,
          settledRecords: 1,
          overriddenByPerson: 2,
        }),
      ),
    );
    const plot = tenant().plots[0];
    const user = userEvent.setup();
    renderCard();
    await user.click(
      await screen.findByRole("button", {
        name: "Precio especial para un lote",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByLabelText("¿Qué lote?"));
    await user.click(await screen.findByRole("option", { name: plot.name }));
    expect(
      await within(dialog).findByText(/3 pesadas sin liquidar cambian/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/1 pesada ya liquidada no cambia/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/2 pesadas son de personas con precio propio/),
    ).toBeInTheDocument();
  }, 30000);

  it("says nothing is on the books yet, or that the settled part stays", async () => {
    let answer = {
      unsettledRecords: 0,
      settledRecords: 0,
      overriddenByPerson: 0,
    };
    server.use(
      http.get("*/v1/prices/special/:kind/:id/:monday/impact", () =>
        HttpResponse.json(answer),
      ),
    );
    const plot = tenant().plots[0];
    const user = userEvent.setup();
    renderCard();
    await user.click(
      await screen.findByRole("button", {
        name: "Precio especial para un lote",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByLabelText("¿Qué lote?"));
    await user.click(await screen.findByRole("option", { name: plot.name }));
    expect(
      await within(dialog).findByText(/Todavía no hay pesadas/),
    ).toBeInTheDocument();

    answer = { unsettledRecords: 1, settledRecords: 0, overriddenByPerson: 0 };
    await user.click(within(dialog).getByLabelText("Desde"));
    const options = await screen.findAllByRole("option");
    await user.click(options[0]);
    expect(
      await within(dialog).findByText(
        /1 pesada sin liquidar cambia\. Lo ya liquidado no cambia\./,
      ),
    ).toBeInTheDocument();
  }, 30000);
});

describe("an existing price", () => {
  it("can be changed, shows what is coming and keeps a history", async () => {
    const [plot, other] = tenant().plots;
    tenant().specialPrices = [
      {
        kind: "lote",
        targetId: plot.id,
        validFrom: "2026-01-05",
        priceCents: 110_000,
        createdAt: "",
      },
      {
        kind: "lote",
        targetId: plot.id,
        validFrom: "2099-01-05",
        priceCents: 140_000,
        createdAt: "",
      },
      {
        kind: "lote",
        targetId: other.id,
        validFrom: "2026-01-05",
        priceCents: 90_000,
        createdAt: "",
      },
      {
        kind: "lote",
        targetId: other.id,
        validFrom: "2099-01-05",
        priceCents: null,
        createdAt: "",
      },
    ];
    const user = userEvent.setup();
    renderCard();
    expect(await screen.findByText(/sin precio especial$/)).toBeInTheDocument();
    expect(screen.getByText(/: \$\s?1\.400$/)).toBeInTheDocument();

    const toggles = screen.getAllByRole("button", { name: /Ver historial/ });
    await user.click(toggles[0]);
    expect(
      await screen.findByRole("button", { name: "Ocultar historial" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/por kilo$|sin precio especial$/).length,
    ).toBeGreaterThan(1);
    await user.click(screen.getByRole("button", { name: "Ocultar historial" }));

    await user.click(screen.getAllByRole("button", { name: "Cambiar" })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/^Cambiar el precio de /),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("¿Qué lote?"),
    ).not.toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText("Precio especial por kilo en pesos"),
      "1250",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Guardar precio especial" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(tenant().specialPrices!.some((p) => p.priceCents === 125_000)).toBe(
      true,
    );
  }, 30000);
});

describe("when the server says no", () => {
  it("keeps the dialog open with the reason", async () => {
    server.use(http.put("*/v1/prices/special/:kind/:id/:monday", boom));
    const plot = tenant().plots[0];
    const user = userEvent.setup();
    renderCard();
    await user.click(
      await screen.findByRole("button", {
        name: "Precio especial para un lote",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByLabelText("¿Qué lote?"));
    await user.click(await screen.findByRole("option", { name: plot.name }));
    await user.type(
      within(dialog).getByLabelText("Precio especial por kilo en pesos"),
      "1200",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Guardar precio especial" }),
    );
    await waitFor(() =>
      expect(dialog.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  }, 30000);

  it("says the prices could not be read", async () => {
    server.use(
      http.get("*/v1/prices/special", () =>
        HttpResponse.json(
          { error: { code: "BAD_REQUEST", message: "bad" } },
          { status: 400 },
        ),
      ),
    );
    renderCard();
    expect(
      await screen.findByText(/No se pudieron leer los precios especiales/),
    ).toBeInTheDocument();
  }, 30000);
});
