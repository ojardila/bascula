/**
 * Farm user management, the remaining edges: the guided tour driving the two
 * invitation dialogs (steps 3 to 7), a 403 on the list, people the server
 * sends without a name, an invitation that brings back no password, and a
 * late click on a confirmation that has already been answered.
 *
 * The tour is a stand-in provider here, not the real one: what is under test
 * is how this page answers the tour, not how the tour saves its progress.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { FarmUsersPage } from "./FarmUsersPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";
import {
  TourContext,
  type TourContextValue,
  type TourSummary,
} from "../onboarding/TourContext";
import { stepOf, type TourName } from "../onboarding/steps";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const SUMMARY: TourSummary = { owners: 0, people: 0, plot: null, priceCents: null };

interface TourLog {
  goTo: number[];
  notes: Partial<TourSummary>[];
}

function FakeTour({
  start,
  log,
  children,
}: Readonly<{
  start: { tour: TourName; n: number } | null;
  log: TourLog;
  children: ReactNode;
}>) {
  const [cur, setCur] = useState(start);
  const [paused, setPaused] = useState(false);
  const actions = useRef(new Map<string, () => boolean | Promise<boolean>>());

  const registerAction = useCallback(
    (name: string, fn: () => boolean | Promise<boolean>) => {
      actions.current.set(name, fn);
      return () => {
        actions.current.delete(name);
      };
    },
    [],
  );
  const runAction = useCallback(async (name: string) => {
    const fn = actions.current.get(name);
    return fn ? fn() : false;
  }, []);

  const value = useMemo<TourContextValue>(
    () => ({
      current: cur ? { ...cur, def: stepOf(cur.tour, cur.n)! } : null,
      paused,
      saved: {},
      loaded: true,
      available: null,
      summary: SUMMARY,
      start: () => {},
      resume: () => {},
      goTo: (n) => {
        log.goTo.push(n);
        setPaused(false);
        setCur((c) => (c ? { ...c, n } : c));
      },
      pause: () => setPaused(true),
      later: () => {},
      dismiss: () => {},
      finish: () => {},
      isAt: (t, n) => !!cur && !paused && cur.tour === t && cur.n === n,
      registerAction,
      runAction,
      note: (p) => {
        log.notes.push(typeof p === "function" ? p(SUMMARY) : p);
      },
    }),
    [cur, paused, log, registerAction, runAction],
  );

  return (
    <TourContext.Provider value={value}>
      <button type="button" onClick={() => void runAction("open-owner-invite")}>
        tour: invitar dueño
      </button>
      <button type="button" onClick={() => void runAction("open-invite")}>
        tour: invitar
      </button>
      {children}
    </TourContext.Provider>
  );
}

function renderUsers(
  tour: { start: { tour: TourName; n: number } | null; log: TourLog } | null = null,
) {
  const page = <FarmUsersPage />;
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/configuracion/usuarios"]}>
        <AuthProvider>
          <Routes>
            <Route
              path="/configuracion/usuarios"
              element={
                tour ? (
                  <FakeTour start={tour.start} log={tour.log}>
                    {page}
                  </FakeTour>
                ) : (
                  page
                )
              }
            />
            <Route path="/configuracion" element={<div>configuración</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const newLog = (): TourLog => ({ goTo: [], notes: [] });

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

type User = ReturnType<typeof userEvent.setup>;

const inviteDialog = () =>
  screen.findByRole("dialog", { name: "Invitar a alguien a la finca" });
const ownerDialog = () =>
  screen.findByRole("dialog", { name: "Invitar a otro dueño" });

async function fillInvite(user: User, dialog: HTMLElement, email: string, name: string) {
  await user.type(within(dialog).getByLabelText("Correo"), email);
  await user.type(within(dialog).getByLabelText("Nombre"), name);
}

describe("the tour opens the dialogs and waits for them", () => {
  it("step 3 opens the owner invitation and moves on to step 4 when it closes", async () => {
    const log = newLog();
    const user = userEvent.setup();
    renderUsers({ start: { tour: "owner", n: 3 }, log });
    await screen.findByText("Gloria Betancur");

    await user.click(screen.getByRole("button", { name: "tour: invitar dueño" }));
    const dialog = await ownerDialog();
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(log.goTo).toEqual([4]));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Invitar a otro dueño" })).toBeNull(),
    );

    // At step 4 the owner dialog is no longer the tour's: closing it again
    // leaves the tour where it is.
    await user.click(screen.getByRole("button", { name: /Invitar a otro dueño/ }));
    const again = await ownerDialog();
    await user.click(within(again).getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Invitar a otro dueño" })).toBeNull(),
    );
    expect(log.goTo).toEqual([4]);

    // Step 4 opens the ordinary invitation; closing it outside step 5 does
    // not send the tour anywhere.
    await user.click(screen.getByRole("button", { name: "tour: invitar" }));
    const invite = await inviteDialog();
    await user.click(within(invite).getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Invitar a alguien a la finca" })).toBeNull(),
    );
    expect(log.goTo).toEqual([4]);
  }, 30000);

  it("step 5 refuses an empty form, and backing out returns to step 4", async () => {
    const log = newLog();
    const user = userEvent.setup();
    renderUsers({ start: { tour: "owner", n: 5 }, log });
    await screen.findByText("Gloria Betancur");
    await user.click(screen.getByRole("button", { name: "Invitar a alguien" }));
    const dialog = await inviteDialog();

    const callout = within(dialog).getByRole("dialog", { name: /^Paso 5 de 11/ });
    await user.click(within(callout).getByRole("button", { name: "Continuar" }));
    expect(
      await within(dialog).findByText("Escriba el correo y el nombre de la persona."),
    ).toBeInTheDocument();
    expect(log.goTo).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(log.goTo).toEqual([4]));
  }, 30000);

  it("step 5 sends the invitation and step 6 closes the credential", async () => {
    const log = newLog();
    const user = userEvent.setup();
    renderUsers({ start: { tour: "owner", n: 5 }, log });
    await screen.findByText("Gloria Betancur");
    await user.click(screen.getByRole("button", { name: "Invitar a alguien" }));
    const dialog = await inviteDialog();
    await fillInvite(user, dialog, "elena@laesperanza.co", "Elena Zapata");

    const callout = within(dialog).getByRole("dialog", { name: /^Paso 5 de 11/ });
    await user.click(within(callout).getByRole("button", { name: "Continuar" }));

    const done = await screen.findByRole("dialog", { name: /Elena Zapata ya tiene acceso/ });
    expect(log.goTo).toContain(6);
    expect(log.notes).toContainEqual({ people: 1 });

    const six = within(done).getByRole("dialog", { name: /^Paso 6 de 11/ });
    await user.click(within(six).getByRole("button", { name: "Continuar" }));
    await waitFor(() => expect(log.goTo).toContain(7));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /ya tiene acceso/ })).toBeNull(),
    );
  }, 30000);

  it("counts an invited owner as an owner", async () => {
    const log = newLog();
    const user = userEvent.setup();
    renderUsers({ start: null, log });
    await screen.findByText("Gloria Betancur");
    await user.click(screen.getByRole("button", { name: /Invitar a otro dueño/ }));
    const dialog = await ownerDialog();
    await fillInvite(user, dialog, "ana@laesperanza.co", "Ana Ardila");
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Invitar como dueño" }));

    const done = await screen.findByRole("dialog", { name: /Ana Ardila ya tiene acceso/ });
    expect(log.notes).toContainEqual({ owners: 1 });
    await user.click(within(done).getByRole("button", { name: "Ya la apunté" }));
    expect(log.goTo).toEqual([]);
  }, 30000);
});

describe("what the server sends back", () => {
  it("shows the permission screen on a 403", async () => {
    let answered = false;
    server.use(
      http.get("*/v1/users", () => {
        answered = true;
        return HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        );
      }),
    );
    renderUsers();
    // The same screen shows for a moment while the session loads, so wait for
    // the list's own refusal before reading it.
    await waitFor(() => expect(answered).toBe(true));
    await new Promise((r) => setTimeout(r, 100));
    expect(
      await screen.findByText("No tiene permiso para gestionar los usuarios"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Usuarios de la finca")).not.toBeInTheDocument();
  }, 20000);

  it("says something went wrong when the invitation's answer cannot be read", async () => {
    server.use(
      http.post("*/v1/users", () => new HttpResponse("{not json", { status: 201 })),
    );
    const user = userEvent.setup();
    renderUsers();
    await screen.findByText("Gloria Betancur");
    await user.click(screen.getByRole("button", { name: "Invitar a alguien" }));
    const dialog = await inviteDialog();
    await fillInvite(user, dialog, "rota@laesperanza.co", "Respuesta Rota");
    await user.click(within(dialog).getByRole("button", { name: "Enviar la invitación" }));
    await waitFor(() =>
      expect(dialog.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    // Still the form: nothing claims the person was invited.
    expect(screen.queryByRole("dialog", { name: /ya tiene acceso/ })).toBeNull();
  }, 30000);

  it("puts a dash where a name is missing, and says nobody else was invited", async () => {
    server.use(
      http.get("*/v1/users", () =>
        HttpResponse.json({
          items: [
            {
              id: OWNER,
              email: "oscar@laesperanza.co",
              name: "Oscar Jaramillo",
              role: "owner",
              status: "active",
              lastLoginAt: null,
              createdAt: "2026-01-01T00:00:00Z",
            },
            {
              id: "0192f3a0-0001-7000-8000-0000000000f1",
              email: "socio@laesperanza.co",
              name: "",
              role: "owner",
              status: "invited",
              lastLoginAt: null,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      ),
    );
    renderUsers();
    const owners = (await screen.findByText("socio@laesperanza.co")).closest(
      '[data-tour="owners"]',
    ) as HTMLElement;
    expect(within(owners).getByText("—")).toBeInTheDocument();
    expect(
      screen.getByText(/Todavía no ha invitado a nadie/),
    ).toBeInTheDocument();
  }, 20000);

  it("puts a dash for a nameless administrator too", async () => {
    server.use(
      http.get("*/v1/users", () =>
        HttpResponse.json({
          items: [
            {
              id: "0192f3a0-0001-7000-8000-0000000000f2",
              email: "sin.nombre@laesperanza.co",
              name: "",
              role: "admin",
              status: "active",
              lastLoginAt: "2026-08-01T12:00:00Z",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      ),
    );
    renderUsers();
    const row = (await screen.findByText("sin.nombre@laesperanza.co")).closest("tr")!;
    expect(within(row).getByText("—")).toBeInTheDocument();
  }, 20000);

  it("says nothing new was made for somebody who already had access", async () => {
    server.use(
      http.post("*/v1/users", async ({ request }) => {
        const body = (await request.json()) as { id: string; email: string };
        return HttpResponse.json(
          { id: body.id, email: body.email, name: "", role: "weigher", status: "active" },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderUsers();
    await screen.findByText("Gloria Betancur");
    await user.click(screen.getByRole("button", { name: "Invitar a alguien" }));
    const dialog = await inviteDialog();
    await fillInvite(user, dialog, "ya@laesperanza.co", "Ya Estaba");
    await user.click(within(dialog).getByRole("button", { name: "Enviar la invitación" }));

    // No name came back, so the email stands in for it.
    const done = await screen.findByRole("dialog", { name: /ya@laesperanza.co ya tiene acceso/ });
    expect(within(done).getByText(/ya tenía acceso a esta finca/)).toBeInTheDocument();
    expect(within(done).queryByText("Contraseña temporal")).not.toBeInTheDocument();
  }, 30000);

  it("speaks of 'ella' when the new person came back without a name", async () => {
    server.use(
      http.post("*/v1/users", async ({ request }) => {
        const body = (await request.json()) as { id: string; email: string };
        return HttpResponse.json(
          {
            id: body.id,
            email: body.email,
            name: "",
            role: "weigher",
            status: "invited",
            temporaryPassword: "temporal-xyz",
          },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderUsers();
    await screen.findByText("Gloria Betancur");
    await user.click(screen.getByRole("button", { name: "Invitar a alguien" }));
    const dialog = await inviteDialog();
    await fillInvite(user, dialog, "nueva@laesperanza.co", "Nueva");
    await user.click(within(dialog).getByRole("button", { name: "Enviar la invitación" }));

    const done = await screen.findByRole("dialog", { name: /nueva@laesperanza.co ya tiene acceso/ });
    expect(within(done).getByText("temporal-xyz")).toBeInTheDocument();
    expect(within(done).getByText(/se comunica con ella\./)).toBeInTheDocument();
  }, 30000);
});

describe("taking access away", () => {
  it("ignores a click on the confirmation once it has been answered", async () => {
    let calls = 0;
    server.events.on("request:start", ({ request }) => {
      if (request.method === "DELETE" && request.url.includes("/v1/users/")) calls += 1;
    });
    const user = userEvent.setup();
    renderUsers();
    const row = (await screen.findByText("Gloria Betancur")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Quitar acceso" }));
    const dialog = await screen.findByRole("dialog", { name: "¿Quitar el acceso?" });
    const confirm = within(dialog).getByRole("button", { name: "Sí, quitar el acceso" });
    fireEvent.click(confirm);
    // Answered: the body no longer names anybody, but the dialog is still on
    // its way out.
    await waitFor(() =>
      expect(within(dialog).queryByText(/Gloria Betancur no podrá/)).toBeNull(),
    );
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "¿Quitar el acceso?" })).toBeNull(),
    );
    expect(calls).toBe(1);
    server.events.removeAllListeners();
  }, 30000);
});
