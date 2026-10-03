// SPDX-License-Identifier: MIT
/**
 * The weighing screen in the corners the main suite does not reach: no
 * storage on the phone, the queue going offline and back, an upload the
 * server refuses for good, a weigher who cannot undo, many lotes, one lote,
 * people without a basket and teams of one.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
import { WeighingForm } from "./WeighingForm";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const WEIGHER = "0192f3a0-0001-7000-8000-000000000003";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";
const JHON = "0192f3a0-0006-7000-8000-000000000002";
const LUZ = "0192f3a0-0006-7000-8000-000000000003";

const tenant = () => db.tenantOf(db.FARM_ID)!;

function signIn(userId = OWNER) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
}

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
  signIn();
});

type User = ReturnType<typeof userEvent.setup>;

async function pickPerson(user: User, name: RegExp) {
  await user.click(await screen.findByLabelText(/^Persona/));
  await user.click(await screen.findByRole("option", { name }));
}

async function save(user: User) {
  await user.click(screen.getByRole("button", { name: "Guardar pesada" }));
}

function goOffline() {
  act(() => {
    window.dispatchEvent(new Event("offline"));
  });
}

function goOnline() {
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
}

/** The card that lists what is still on the phone. */
function pendingCard(): HTMLElement {
  return screen
    .getByText(/^Pesadas por subir/)
    .closest(".MuiCard-root") as HTMLElement;
}

/** A browser that will not open IndexedDB (some private modes). */
function noStorage() {
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = undefined;
}

describe("offline, with storage on the phone", () => {
  it("keeps a weighing for yesterday on the phone and drops it with «Deshacer»", async () => {
    let posted = 0;
    server.use(
      http.post("*/v1/work-records", () => {
        posted += 1;
        return HttpResponse.error();
      }),
    );
    const user = userEvent.setup();
    renderWeighing();
    await screen.findByLabelText(/^Persona/);
    goOffline();
    await pickPerson(user, /María Restrepo Ospina/);
    await user.click(screen.getByRole("button", { name: "El Alto" }));
    await user.click(screen.getByRole("button", { name: "Ayer" }));
    await user.type(screen.getByLabelText("Kilos"), "21");
    await save(user);

    expect(
      await screen.findByText(/Guardado en este celular: María Restrepo Ospina, 21 kg/),
    ).toBeInTheDocument();
    // It never tried the network: the app already knew there was no signal.
    expect(posted).toBe(0);
    const card = pendingCard();
    expect(within(card).getByText(/^El Alto · /)).toBeInTheDocument();
    expect(within(card).queryByText(/· hoy$/)).not.toBeInTheDocument();
    // Offline there is nothing to upload to.
    expect(
      within(card).queryByRole("button", { name: "Subir ahora" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Deshacer" }));
    expect(
      await screen.findByText("Se borró la pesada de María Restrepo Ospina: 21 kg."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(/^Pesadas por subir/)).not.toBeInTheDocument(),
    );
    const info = screen
      .getByText(/Se borró la pesada/)
      .closest('[role="alert"]') as HTMLElement;
    await user.click(within(info).getByRole("button"));
    expect(screen.queryByText(/Se borró la pesada/)).not.toBeInTheDocument();
  }, 30000);

  it("marks an upload the server refuses for good and lets it be deleted", async () => {
    let refuse = false;
    server.use(
      http.post("*/v1/work-records", () =>
        refuse
          ? HttpResponse.json(
              {
                error: {
                  code: "VALIDATION_ERROR",
                  message: "El lote ya no existe",
                  details: {},
                },
              },
              { status: 422 },
            )
          : HttpResponse.error(),
      ),
    );
    const user = userEvent.setup();
    renderWeighing();
    await pickPerson(user, /María Restrepo Ospina/);
    await user.click(screen.getByRole("button", { name: "El Alto" }));
    await user.type(screen.getByLabelText("Kilos"), "30");
    await save(user);
    // No answer from the server: kept on the phone, dated today.
    expect(
      await screen.findByText(/Guardado en este celular: María Restrepo Ospina, 30 kg/),
    ).toBeInTheDocument();
    expect(within(pendingCard()).getByText("El Alto · hoy")).toBeInTheDocument();

    refuse = true;
    goOnline();
    expect(
      await within(pendingCard()).findByText(/^No se pudo subir: /),
    ).toBeInTheDocument();
    // Pressing «Subir ahora» again leaves the refused one where it is.
    await user.click(
      within(pendingCard()).getByRole("button", { name: "Subir ahora" }),
    );
    await waitFor(() =>
      expect(
        within(pendingCard()).getByRole("button", { name: "Subir ahora" }),
      ).toBeEnabled(),
    );
    expect(within(pendingCard()).getByText(/^No se pudo subir: /)).toBeInTheDocument();

    await user.click(within(pendingCard()).getByRole("button", { name: "Borrar" }));
    await waitFor(() =>
      expect(screen.queryByText(/^Pesadas por subir/)).not.toBeInTheDocument(),
    );
  }, 30000);

  it("works from the saved lists and the warning can be dismissed", async () => {
    const user = userEvent.setup();
    const first = renderWeighing();
    await user.click(await screen.findByLabelText(/^Persona/));
    expect(
      await screen.findByRole("option", { name: /María Restrepo Ospina/ }),
    ).toBeInTheDocument();
    first.unmount();
    invalidateRefs();

    server.use(http.get("*/v1/workers", () => HttpResponse.error()));
    renderWeighing();
    const warning = (
      await screen.findByText(/Sin señal: usando la lista de personas y lotes guardada/)
    ).closest('[role="alert"]') as HTMLElement;
    await user.click(within(warning).getByRole("button"));
    expect(
      screen.queryByText(/Sin señal: usando la lista/),
    ).not.toBeInTheDocument();
  }, 30000);
});

describe("a phone with no storage", () => {
  it("says the weighing could not be saved instead of pretending to keep it", async () => {
    noStorage();
    server.use(http.post("*/v1/work-records", () => HttpResponse.error()));
    const user = userEvent.setup();
    renderWeighing();
    await pickPerson(user, /María Restrepo Ospina/);
    goOffline();
    await user.click(screen.getByRole("button", { name: "El Alto" }));
    await user.type(screen.getByLabelText("Kilos"), "18");
    await save(user);
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((a) => a.className.includes("MuiAlert-colorError")),
      ).toBe(true),
    );
    expect(screen.queryByText(/Guardado/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Kilos")).toHaveValue("18");
  }, 30000);

  it("says there is no saved list when the server cannot be reached either", async () => {
    noStorage();
    server.use(http.get("*/v1/plots", () => HttpResponse.error()));
    renderWeighing();
    expect(
      await screen.findByText(/Sin señal y sin lista guardada/),
    ).toBeInTheDocument();
  }, 30000);

  it("shows nothing once the screen was left before the saved list came back", async () => {
    // Storage that answers late: the screen is gone by the time it does.
    let failOpen: (() => void) | null = null;
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open() {
        const req: { onerror?: () => void; error: null } = { error: null };
        failOpen = () => req.onerror?.();
        return req;
      },
    };
    let asked = false;
    server.use(
      http.get("*/v1/plots", () => {
        asked = true;
        return HttpResponse.error();
      }),
    );
    const view = renderWeighing();
    await waitFor(() => expect(asked).toBe(true));
    await waitFor(() => expect(failOpen).not.toBeNull());
    // Let the failed lists reach the storage before leaving.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    view.unmount();
    await act(async () => {
      failOpen?.();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByText(/Sin señal y sin lista guardada/)).not.toBeInTheDocument();
  }, 30000);
});

describe("leaving before the lists answer", () => {
  it("does not show a refusal that arrives after the screen was left", async () => {
    const waiting: (() => void)[] = [];
    server.use(
      http.get("*/v1/plots", async () => {
        await new Promise<void>((r) => {
          waiting.push(r);
        });
        return HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no", details: {} } },
          { status: 403 },
        );
      }),
    );
    const view = renderWeighing();
    await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
    view.unmount();
    await act(async () => {
      for (const answer of waiting) answer();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByText(/no tiene permiso/)).not.toBeInTheDocument();
  }, 30000);
});

describe("who can undo", () => {
  it("a weigher saves but gets no «Deshacer» for a weighing already on the server", async () => {
    signIn(WEIGHER);
    const user = userEvent.setup();
    renderWeighing();
    await pickPerson(user, /María Restrepo Ospina/);
    await user.click(screen.getByRole("button", { name: "El Alto" }));
    await user.type(screen.getByLabelText("Kilos"), "14");
    await save(user);
    expect(
      await screen.findByText(/Guardado: María Restrepo Ospina, 14 kg/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deshacer" })).not.toBeInTheDocument();
  }, 30000);

  it("shows the server's refusal when undoing fails", async () => {
    server.use(
      http.patch("*/v1/work-records/:id", () =>
        HttpResponse.json(
          { error: { code: "CONFLICT", message: "Ya está liquidada", details: {} } },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWeighing();
    await pickPerson(user, /María Restrepo Ospina/);
    await user.click(screen.getByRole("button", { name: "El Alto" }));
    await user.type(screen.getByLabelText("Kilos"), "19");
    await save(user);
    await screen.findByText(/Guardado: María Restrepo Ospina, 19 kg/);
    await user.click(screen.getByRole("button", { name: "Deshacer" }));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((a) => a.className.includes("MuiAlert-colorError")),
      ).toBe(true),
    );
    expect(screen.getByText("Guardadas en esta pantalla")).toBeInTheDocument();
  }, 30000);
});

describe("lotes", () => {
  it("picks the only lote by itself", async () => {
    const t = tenant();
    for (const p of t.plots.slice(1)) p.deletedAt = "2026-01-01T00:00:00Z";
    const only = t.plots[0].name;
    renderWeighing();
    expect(
      await screen.findByRole("button", { name: only, pressed: true }),
    ).toBeInTheDocument();
  }, 30000);

  it("is a list instead of buttons when there are many", async () => {
    const t = tenant();
    const base = t.plots[0];
    for (let i = 1; i <= 4; i++) {
      t.plots.push({
        ...base,
        id: `0192f3a0-0005-7000-8000-0000000009${i}0`,
        name: `Lote extra ${i}`,
      });
    }
    const user = userEvent.setup();
    renderWeighing();
    await pickPerson(user, /María Restrepo Ospina/);
    expect(screen.queryByRole("button", { name: "El Alto" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: /^Lote/ }));
    await user.click(await screen.findByRole("option", { name: "Lote extra 3" }));
    await user.type(screen.getByLabelText("Kilos"), "11");
    await save(user);
    expect(
      await screen.findByText(/Guardado: María Restrepo Ospina, 11 kg/),
    ).toBeInTheDocument();
    expect(screen.getByText("Lote extra 3 · hoy")).toBeInTheDocument();
  }, 30000);
});

describe("people", () => {
  it("warns about a person with no basket number", async () => {
    tenant().workers.push({
      ...tenant().workers.find((w) => w.id === MARIA)!,
      id: "0192f3a0-0006-7000-8000-0000000000b1",
      name: "Sinforoso",
      lastName: "Sin Canasto",
      docId: "99887766",
      tag: null,
    });
    const user = userEvent.setup();
    renderWeighing();
    await user.click(await screen.findByLabelText(/^Persona/));
    const option = await screen.findByRole("option", { name: /Sinforoso/ });
    expect(within(option).getByText("Sin canasto")).toBeInTheDocument();
    await user.click(option);
    expect(
      await screen.findAllByText(/Sinforoso Sin Canasto/),
    ).not.toHaveLength(0);
  }, 30000);

  it("weighs a member alone when their team is not on the list", async () => {
    const team = await api.createWorker({
      id: "0192f3a0-0006-7000-8000-0000000000c1",
      name: "Los Viejos",
      tag: "41",
      kind: "equipo",
      memberIds: [JHON, LUZ],
    } as Parameters<typeof api.createWorker>[0]);
    // The team left the farm; the people still carry its name.
    tenant().workers.find((w) => w.id === team.id)!.deletedAt =
      "2026-01-01T00:00:00Z";
    invalidateRefs();
    const user = userEvent.setup();
    renderWeighing();
    await user.click(await screen.findByLabelText(/^Persona/));
    const member = (await screen.findAllByRole("option", { name: /Jhon Fredy/ }))[0];
    await user.click(member);
    // The chosen person is shown big under the picker: the member, not a team.
    expect(await screen.findByText("Jhon Fredy Cardona Loaiza")).toBeInTheDocument();
    expect(
      screen.queryByText(/Se pesa todo junto, a nombre del equipo/),
    ).not.toBeInTheDocument();
  }, 30000);

  it("says the kilos go to a team of one without a per-person split", async () => {
    await api.createWorker({
      id: "0192f3a0-0006-7000-8000-0000000000d1",
      name: "Equipo Solo",
      tag: "42",
      kind: "equipo",
      memberIds: [LUZ],
    } as Parameters<typeof api.createWorker>[0]);
    invalidateRefs();
    const user = userEvent.setup();
    renderWeighing();
    await user.click(await screen.findByLabelText(/^Persona/));
    const team = (
      await screen.findAllByRole("option", { name: /Equipo Solo/ })
    ).find((o) => !o.textContent?.includes("Pesa con"));
    await user.click(team!);
    await user.type(screen.getByLabelText("Kilos"), "50");
    expect(screen.getByText(/Se anotan/)).toHaveTextContent(
      "Se anotan 50 kg al equipo.",
    );
    expect(screen.queryByText(/por persona/)).not.toBeInTheDocument();
  }, 30000);
});

describe("the doubt about a heavy sack", () => {
  it("closes with Escape and saves nothing", async () => {
    const before = tenant().workRecords.length;
    const user = userEvent.setup();
    renderWeighing();
    await pickPerson(user, /María Restrepo Ospina/);
    await user.click(screen.getByRole("button", { name: "El Alto" }));
    await user.type(screen.getByLabelText("Kilos"), "500");
    await save(user);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(tenant().workRecords.length).toBe(before);
    expect(screen.getByLabelText("Kilos")).toHaveValue("500");
  }, 30000);
});

describe("rendered without a signed-in farm", () => {
  it("still opens, in the farm's default time zone, and shows the refusal", async () => {
    setTokens(null);
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <AuthProvider>
            <WeighingForm />
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(await screen.findByRole("button", { name: "Hoy" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((a) => a.className.includes("MuiAlert-colorError")),
      ).toBe(true),
    );
  }, 30000);
});
