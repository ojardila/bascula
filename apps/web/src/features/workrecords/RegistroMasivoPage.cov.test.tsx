// SPDX-License-Identifier: MIT
/**
 * «Registro de recolección masivo», the edges: a link to a day still to come,
 * a farm with no timezone, a farm with one lote, a week that will not load or
 * is left before it loads, losing the signal, the phone's search scroll, the
 * name that takes you to the kilos, «Revisar» while searching, a lote that no
 * longer exists, closing the messages, and correcting two pesadas at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { delay, http, HttpResponse } from "msw";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { server } from "../../mocks/node";
import { todayInFarm } from "../../lib/dates";
import { dayTitle } from "./RegistroMasivoPage";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const ALTO = "0192f3a0-0004-7000-8000-000000000001";
const DAY = "2026-08-24";
const JHON = "Jhon Fredy Cardona Loaiza";
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

let posted: string[] = [];
const onRequest = ({ request }: { request: Request }) => {
  if (
    request.method === "POST" &&
    new URL(request.url).pathname.endsWith("/v1/work-records")
  )
    posted.push(request.url);
};

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  localStorage.clear();
  posted = [];
  server.events.on("request:start", onRequest);
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});
afterEach(() => {
  server.events.removeListener("request:start", onRequest);
  vi.restoreAllMocks();
  localStorage.clear();
});

type User = ReturnType<typeof userEvent.setup>;
const kilos = (name = JHON) => screen.findByLabelText(`${name}, kilos`);
const tenant = () => db.tenantOf(db.FARM_ID)!;
const errorAlert = () => document.querySelector(".MuiAlert-colorError");

async function addPesada(user: User, kg: string) {
  await user.type(await kilos(), kg);
  await user.click(screen.getByRole("button", { name: "Guardar" }));
  await user.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Sí, guardar",
    }),
  );
  await screen.findByText(/Se agregó 1 pesada nueva/);
}

describe("which day it opens on", () => {
  it("opens a link to a day still to come on today", async () => {
    const today = todayInFarm("America/Bogota");
    renderApp(`/cosecha/registro-masivo?dia=2099-01-05&lote=${ALTO}`);
    expect(
      await screen.findByText(dayTitle(today, today)),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Ir a hoy" }),
    ).not.toBeInTheDocument();
  }, 30000);

  it("reads today in Bogotá when the farm says no timezone", async () => {
    server.use(
      http.get("*/v1/me", () =>
        HttpResponse.json({
          id: OWNER,
          email: "oscar@laesperanza.co",
          name: "Oscar Jaramillo",
          role: "owner",
          farm: { id: db.FARM_ID, name: "La Esperanza", currency: "COP", slug: "la-esperanza" },
          superadmin: false,
        }),
      ),
    );
    const today = todayInFarm("America/Bogota");
    renderApp(`/cosecha/registro-masivo?lote=${ALTO}`);
    expect(
      await screen.findByText(dayTitle(today, today)),
    ).toBeInTheDocument();
  }, 30000);
});

describe("which lote it opens on", () => {
  it("takes the only lote the farm has", async () => {
    for (const p of tenant().plots)
      if (p.id !== ALTO) p.deletedAt = "2026-01-01T00:00:00Z";
    renderApp(`/cosecha/registro-masivo?dia=${DAY}`);
    await kilos();
    await waitFor(() =>
      expect(screen.getByLabelText(/de las pesadas nuevas/)).toHaveTextContent(
        "El Alto",
      ),
    );
  }, 30000);

  it("saves nothing on a lote that no longer exists", async () => {
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=gone`);
    await user.type(await kilos(), "20");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/· el lote/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Sí, guardar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(posted).toEqual([]);
    expect(await kilos()).toHaveValue("20");
  }, 30000);
});

describe("the week's pesadas", () => {
  it("says so when they do not load", async () => {
    server.use(
      http.get("*/v1/work-records", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom" } },
          { status: 500 },
        ),
      ),
    );
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await waitFor(() => expect(errorAlert()).not.toBeNull());
    expect(screen.queryByLabelText(`${JHON}, kilos`)).not.toBeInTheDocument();
  }, 30000);

  it("forgets a failed answer for a week already left", async () => {
    server.use(
      http.get(
        "*/v1/work-records",
        async () => {
          await delay(600);
          return HttpResponse.json(
            { error: { code: "INTERNAL", message: "boom" } },
            { status: 500 },
          );
        },
        { once: true },
      ),
    );
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await user.click(
      await screen.findByRole("button", { name: "Semana anterior" }),
    );
    expect(await screen.findByText("Lunes 17 de agosto")).toBeInTheDocument();
    await kilos();
    await act(() => new Promise((r) => setTimeout(r, 800)));
    expect(errorAlert()).toBeNull();
    expect(screen.getByLabelText(`${JHON}, kilos`)).toBeInTheDocument();
  }, 30000);

  it("forgets a late answer for a week already left", async () => {
    server.use(
      http.get(
        "*/v1/work-records",
        async () => {
          await delay(600);
          return HttpResponse.json({ items: [] });
        },
        { once: true },
      ),
    );
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await user.click(
      await screen.findByRole("button", { name: "Semana anterior" }),
    );
    expect(await screen.findByText("Lunes 17 de agosto")).toBeInTheDocument();
    await kilos();
    await act(() => new Promise((r) => setTimeout(r, 800)));
    expect(screen.getByText("Lunes 17 de agosto")).toBeInTheDocument();
    expect(screen.getByLabelText(`${JHON}, kilos`)).toBeInTheDocument();
  }, 30000);
});

describe("on the phone and with the keyboard", () => {
  it("warns that saving needs signal once it is lost", async () => {
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await kilos();
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(
      await screen.findByText(/Para guardar el registro masivo se necesita señal/),
    ).toBeInTheDocument();
  }, 30000);

  it("brings the search to the top of a small screen", async () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      value: scroll,
      configurable: true,
      writable: true,
    });
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: true,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await kilos();
    await user.click(screen.getByRole("textbox", { name: "Buscar por nombre" }));
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }, 30000);

  it("a tap on the name goes to that person's kilos", async () => {
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    const box = await kilos();
    await user.click(screen.getByText(JHON));
    expect(box).toHaveFocus();
  }, 30000);

  it("«Revisar» while searching goes back to the kilos just typed", async () => {
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await kilos();
    await user.type(
      screen.getByRole("textbox", { name: "Buscar por nombre" }),
      "jhon",
    );
    const box = await kilos();
    await user.type(box, "25");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Revisar" }));
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveValue("25");
    expect(posted).toEqual([]);
  }, 30000);
});

describe("the messages after a save and a correction", () => {
  it("closes the «Listo» of a save", async () => {
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await addPesada(user, "30");
    const done = screen
      .getByText(/Se agregó 1 pesada nueva/)
      .closest(".MuiAlert-root") as HTMLElement;
    await user.click(within(done).getByRole("button", { name: /close|cerrar/i }));
    await waitFor(() =>
      expect(screen.queryByText(/Se agregó 1 pesada nueva/)).not.toBeInTheDocument(),
    );
  }, 30000);

  it("closes «Corregir» without changes", async () => {
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await addPesada(user, "30");
    await user.click(
      await screen.findByRole("button", { name: `Corregir las pesadas de ${JHON}` }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/Se corrigi/)).not.toBeInTheDocument();
  }, 30000);

  it("counts two corrected pesadas, survives a list that does not refresh, and closes", async () => {
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await addPesada(user, "30");
    await addPesada(user, "31");
    await user.click(
      await screen.findByRole("button", { name: `Corregir las pesadas de ${JHON}` }),
    );
    const dialog = await screen.findByRole("dialog");
    const boxes = within(dialog).getAllByLabelText(/^Pesada \d+, kilos$/);
    for (const v of ["30", "31"]) {
      const b = boxes.find((x) => (x as HTMLInputElement).value === v)!;
      await user.clear(b);
      await user.type(b, String(Number(v) + 10));
    }
    // The pesadas are saved; the list after them does not come back.
    server.use(
      http.get("*/v1/work-records", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom" } },
          { status: 500 },
        ),
      ),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Guardar cambios" }),
    );
    const msg = await screen.findByText(/Se corrigieron 2 pesadas de Jhon/);
    expect(errorAlert()).toBeNull();
    const done = msg.closest(".MuiAlert-root") as HTMLElement;
    await user.click(within(done).getByRole("button", { name: /close|cerrar/i }));
    await waitFor(() =>
      expect(screen.queryByText(/Se corrigieron 2 pesadas/)).not.toBeInTheDocument(),
    );
  }, 40000);
});

describe("«Corregir» open while the day refreshes", () => {
  it("shows no pesadas when the refreshed day no longer has them", async () => {
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await addPesada(user, "30");
    await screen.findByRole("button", { name: `Corregir las pesadas de ${JHON}` });
    // The list after the next save is slow, and another device took the
    // person's pesadas out in the meantime.
    server.use(
      http.get(
        "*/v1/work-records",
        async () => {
          await delay(800);
          return HttpResponse.json({ items: [] });
        },
        { once: true },
      ),
    );
    await addPesada(user, "31");
    await user.click(
      screen.getByRole("button", { name: `Corregir las pesadas de ${JHON}` }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getAllByLabelText(/^Pesada \d+, kilos$/).length,
    ).toBeGreaterThan(0);
    await waitFor(
      () =>
        expect(
          within(dialog).queryAllByLabelText(/^Pesada \d+, kilos$/),
        ).toHaveLength(0),
      { timeout: 3000 },
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  }, 30000);
});

describe("the lote remembered", () => {
  it("is not used when it no longer exists, and nothing is picked among several", async () => {
    localStorage.setItem(LAST_LOTE, "gone");
    renderApp(`/cosecha/registro-masivo?dia=${DAY}`);
    expect(await screen.findByText("Elija el lote.")).toBeInTheDocument();
  }, 30000);
});
