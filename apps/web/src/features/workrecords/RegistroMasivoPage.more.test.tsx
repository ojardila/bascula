// SPDX-License-Identifier: MIT
/**
 * «Registro de recolección masivo», the paths around the main flow: which
 * lote it opens on, what it says when the lists or the harvest activity are
 * missing, moving between weeks, Escape in the search, and a refused save.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const ALTO = "0192f3a0-0004-7000-8000-000000000001";
const DAY = "2026-08-24";
const LAST_LOTE = "bascula.registroMasivo.lote";

function renderApp(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  invalidateRefs();
  localStorage.clear();
  setTokens({
    accessToken: `mock-access.${OWNER}.test`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});
afterEach(() => localStorage.clear());

const lotePicker = () => screen.getByLabelText(/de las pesadas nuevas/);

describe("which lote it opens on", () => {
  it("the one used last time, and a new choice is remembered", async () => {
    localStorage.setItem(LAST_LOTE, ALTO);
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}`);
    await screen.findByLabelText("Jhon Fredy Cardona Loaiza, kilos");
    await waitFor(() => expect(lotePicker()).toHaveTextContent("El Alto"));

    await user.click(lotePicker());
    await user.click(
      await screen.findByRole("option", { name: /La Cuchilla/ }),
    );
    await waitFor(() => expect(lotePicker()).toHaveTextContent("La Cuchilla"));
    expect(localStorage.getItem(LAST_LOTE)).not.toBe(ALTO);
  }, 30000);

  it("asks for the lote when there is nothing to go on", async () => {
    renderApp(`/cosecha/registro-masivo?dia=${DAY}`);
    expect(await screen.findByText("Elija el lote.")).toBeInTheDocument();
  }, 30000);
});

describe("when something is missing", () => {
  it("says the farm has no harvest activity at the week's price", async () => {
    server.use(
      http.get("*/v1/activities", () => HttpResponse.json({ items: [] })),
    );
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    expect(
      await screen.findByText(
        /no tiene una actividad de recolección pagada al precio de la semana/,
      ),
    ).toBeInTheDocument();
  }, 30000);

  it("shows the error when the lists do not load", async () => {
    server.use(
      http.get("*/v1/plots", () =>
        HttpResponse.json(
          { error: { code: "BAD_REQUEST", message: "bad" } },
          { status: 400 },
        ),
      ),
    );
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    expect(
      screen.queryByLabelText("Jhon Fredy Cardona Loaiza, kilos"),
    ).not.toBeInTheDocument();
  }, 30000);

  it("shows the permission screen on a 403", async () => {
    server.use(
      http.get("*/v1/workers", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    expect(
      await screen.findByText(/el registro de recolección masivo/),
    ).toBeInTheDocument();
  }, 30000);
});

describe("moving around", () => {
  it("goes a week back, a week forward, and back to today", async () => {
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    expect(await screen.findByText("Lunes 24 de agosto")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Semana anterior" }));
    expect(await screen.findByText("Lunes 17 de agosto")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Semana siguiente" }));
    expect(await screen.findByText("Lunes 24 de agosto")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ir a hoy" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Ir a hoy" }),
      ).not.toBeInTheDocument(),
    );
  }, 30000);

  it("Escape empties the search", async () => {
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await screen.findByLabelText("Jhon Fredy Cardona Loaiza, kilos");
    const search = screen.getByRole("textbox", { name: "Buscar por nombre" });
    await user.type(search, "marin");
    expect(
      screen.queryByLabelText("Jhon Fredy Cardona Loaiza, kilos"),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(
      screen.getByLabelText("Jhon Fredy Cardona Loaiza, kilos"),
    ).toBeInTheDocument();
  }, 30000);
});

describe("a save the server refuses", () => {
  it("keeps the kilos and says why, and the message can be closed", async () => {
    server.use(
      http.post("*/v1/work-records", () =>
        HttpResponse.json(
          { error: { code: "BAD_REQUEST", message: "bad" } },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    const box = await screen.findByLabelText(
      "Jhon Fredy Cardona Loaiza, kilos",
    );
    await user.type(box, "35");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Sí, guardar" }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    expect(
      screen.getByLabelText("Jhon Fredy Cardona Loaiza, kilos"),
    ).toHaveValue("35");
    const alert = document.querySelector(".MuiAlert-colorError") as HTMLElement;
    await user.click(
      within(alert).getByRole("button", {
        name: /close|cerrar/i,
        hidden: true,
      }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).toBeNull(),
    );
  }, 30000);
});
