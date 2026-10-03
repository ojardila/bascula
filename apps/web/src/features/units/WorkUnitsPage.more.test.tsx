// SPDX-License-Identifier: MIT
/**
 * The units screen, the paths `WorkUnitsPage.test.tsx` leaves out: creating
 * a unit (with and without an abbreviation), deleting one nobody used, the
 * server refusing, the list failing, calling dialogs off, and what a weigher
 * gets.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { WorkUnitsPage } from "./WorkUnitsPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const WEIGHER = "0192f3a0-0001-7000-8000-000000000003";

function renderUnits(userId = OWNER) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/unidades"]}>
        <AuthProvider>
          <WorkUnitsPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const refuse = (method: "post" | "delete") =>
  server.use(
    http[method]("*/v1/catalogs/work-units*", () =>
      HttpResponse.json(
        { error: { code: "CONFLICT", message: "No se pudo" } },
        { status: 409 },
      ),
    ),
  );

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
});

describe("a new unit", () => {
  it("is created with the abbreviation typed", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("*/v1/catalogs/work-units", async ({ request }) => {
        body = (await request.clone().json()) as Record<string, unknown>;
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderUnits();
    await user.click(
      await screen.findByRole("button", { name: "Agregar una unidad" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Nueva unidad")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Cómo se llama/), "Arroba");
    await user.type(within(dialog).getByLabelText(/Abreviatura/), "@");
    await user.type(
      within(dialog).getByLabelText(/Cuántos kilos pesa una/),
      "12,5",
    );
    await user.click(within(dialog).getByRole("button", { name: /^Guardar$/ }));
    expect(
      await screen.findByText("«Arroba» quedó creada."),
    ).toBeInTheDocument();
    expect(body).toMatchObject({ code: "@", label: "Arroba", kgFactor: 12.5 });
  });

  it("takes its name as the abbreviation when none is typed", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("*/v1/catalogs/work-units", async ({ request }) => {
        body = (await request.clone().json()) as Record<string, unknown>;
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderUnits();
    await user.click(
      await screen.findByRole("button", { name: "Agregar una unidad" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Cómo se llama/), "Bulto");
    await user.click(within(dialog).getByRole("button", { name: /^Guardar$/ }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.code).toBe("bulto");
  });

  it("keeps the dialog open with the server's refusal", async () => {
    refuse("post");
    const user = userEvent.setup();
    renderUnits();
    await user.click(
      await screen.findByRole("button", { name: "Agregar una unidad" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Cómo se llama/), "Arroba");
    await user.click(within(dialog).getByRole("button", { name: /^Guardar$/ }));
    await waitFor(() =>
      expect(dialog.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("can be called off", async () => {
    const user = userEvent.setup();
    renderUnits();
    await user.click(
      await screen.findByRole("button", { name: "Agregar una unidad" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});

describe("removing a unit", () => {
  it("deletes one nobody used, and the notice can be closed", async () => {
    const user = userEvent.setup();
    renderUnits();
    await user.click(
      await screen.findByRole("button", { name: /Quitar Canasta/i }),
    );
    await user.click(screen.getByRole("button", { name: /^Borrar$/i }));
    const said = await screen.findByText(
      "«Canasta» se borró. Nadie la había usado todavía.",
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await user.click(
      within(said.closest(".MuiAlert-root") as HTMLElement).getByRole(
        "button",
        { name: /close|cerrar/i },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText(/se borró/)).not.toBeInTheDocument(),
    );
  });

  it("shows the server's refusal, which can be closed", async () => {
    refuse("delete");
    const user = userEvent.setup();
    renderUnits();
    await user.click(
      await screen.findByRole("button", { name: /Quitar Canasta/i }),
    );
    await user.click(screen.getByRole("button", { name: /^Borrar$/i }));
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await user.click(
      within(
        document.querySelector(".MuiAlert-colorError") as HTMLElement,
      ).getByRole("button", {
        name: /close|cerrar/i,
      }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).toBeNull(),
    );
  });
});

describe("when it cannot be shown", () => {
  it("says the list could not be read", async () => {
    server.use(
      http.get("*/v1/catalogs/work-units", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "x" } },
          { status: 500 },
        ),
      ),
    );
    renderUnits();
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
  });

  it("is not for a weigher", async () => {
    renderUnits(WEIGHER);
    expect(await screen.findByText(/ver las unidades/)).toBeInTheDocument();
  });
});
