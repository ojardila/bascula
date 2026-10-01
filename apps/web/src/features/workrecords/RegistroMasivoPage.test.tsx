/**
 * «Registro de recolección masivo»: one day, every employee, and every filled
 * box is a NEW pesada. People come to the scale several times a day, so the
 * screen must add, never replace or block.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import type { Worker, WorkRecord } from "../../api/types";
import { api } from "../../api/endpoints";
import { bulkEntries, filterWorkers, foldName, matchesName, plannedCorrections, registeredByWorker, soFarLabel, weekLocks } from "./bulk";
import { dayTitle } from "./RegistroMasivoPage";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const ALTO = "0192f3a0-0004-7000-8000-000000000001";
const JHON = "0192f3a0-0006-7000-8000-000000000002";
const DAY = "2026-08-24";

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

function signIn() {
  setTokens({ accessToken: `mock-access.${OWNER}.test`, refreshToken: `mock-refresh.${OWNER}` });
}

/** Every POST /v1/work-records body, as the server received it. */
let posted: { id: string; workerId: string; quantity: number; dateFrom: string; plotIds: string[] }[] = [];
/** Every PATCH /v1/work-records/{id}: a correction or a removal. */
let patched: { id: string; body: { quantity?: number; status?: string } }[] = [];
const onRequest = async ({ request }: { request: Request }) => {
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path.endsWith("/v1/work-records")) {
    posted.push(await request.clone().json());
  }
  if (request.method === "PATCH" && /\/v1\/work-records\/[^/]+$/.test(path)) {
    patched.push({ id: path.split("/").pop() ?? "", body: await request.clone().json() });
  }
};

beforeEach(() => {
  setTokens(null);
  invalidateRefs();
  localStorage.clear();
  posted = [];
  patched = [];
  server.events.on("request:start", onRequest);
});
afterEach(() => {
  server.events.removeListener("request:start", onRequest);
  vi.restoreAllMocks();
});

/** «Ya tiene: 2 pesadas · 38 kg» for one person, or null. */
function soFarOf(name: RegExp): { count: number; kilos: number } | null {
  const input = screen.getByLabelText(name);
  const card = input.closest(".MuiCard-root") as HTMLElement;
  const m = /Ya tiene: (\d+) pesadas? · ([\d.,]+) kg/.exec(card.textContent ?? "");
  if (!m) return null;
  return { count: Number(m[1]), kilos: Number(m[2].replace(/\./g, "").replace(",", ".")) };
}

describe("Registro de recolección masivo", () => {
  it("adds a new pesada for each filled box, asking before it saves", async () => {
    signIn();
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    expect(await screen.findByRole("heading", { name: "Registro de recolección masivo" })).toBeInTheDocument();
    // The day is chosen first and shown in words.
    expect(await screen.findByText("Lunes 24 de agosto")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lunes 24 de agosto" })).toHaveAttribute("aria-pressed", "true");

    await user.type(await screen.findByLabelText("Jhon Fredy Cardona Loaiza, kilos"), "35");
    await user.type(screen.getByLabelText(/^María .*, kilos$/), "40");
    expect(screen.getByText("2 pesadas nuevas sin guardar")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("¿Guardar el registro del día?")).toBeInTheDocument();
    expect(within(dialog).getByText(/Lunes 24 de agosto · /)).toBeInTheDocument();
    expect(within(dialog).getByText(/Jhon Fredy Cardona Loaiza: 35 kg/)).toBeInTheDocument();
    expect(posted).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Sí, guardar" }));

    const done = await screen.findByText(/Se agregaron 2 pesadas nuevas/, {}, { timeout: 5000 });
    const alert = done.closest("[role=alert]") as HTMLElement;
    expect(within(alert).getByText(/Jhon Fredy Cardona Loaiza:/)).toBeInTheDocument();
    expect(posted).toHaveLength(2);
    for (const b of posted) expect(b).toMatchObject({ dateFrom: DAY, plotIds: [ALTO] });
    expect(posted.map((b) => b.quantity).sort()).toEqual([35, 40]);
    // Only the filled boxes were written, and the boxes are empty again.
    expect(screen.getByLabelText("Jhon Fredy Cardona Loaiza, kilos")).toHaveValue("");
  }, 20000);

  it("lets a person have several pesadas on the same day", async () => {
    signIn();
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    const box = await screen.findByLabelText("Jhon Fredy Cardona Loaiza, kilos");
    const before = soFarOf(/Jhon Fredy Cardona Loaiza, kilos/) ?? { count: 0, kilos: 0 };

    // First trip to the scale.
    await user.type(box, "20");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Sí, guardar" }));
    expect(await screen.findByText(/Se agregó 1 pesada nueva/, {}, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => expect(soFarOf(/Jhon Fredy Cardona Loaiza, kilos/)).toEqual({ count: before.count + 1, kilos: before.kilos + 20 }));

    // Second trip, same amount: still a new pesada, not a replacement.
    await user.type(screen.getByLabelText("Jhon Fredy Cardona Loaiza, kilos"), "20");
    expect(screen.getByLabelText("Jhon Fredy Cardona Loaiza, kilos")).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Sí, guardar" }));
    await waitFor(() => expect(soFarOf(/Jhon Fredy Cardona Loaiza, kilos/)).toEqual({ count: before.count + 2, kilos: before.kilos + 40 }), { timeout: 5000 });

    const jhon = posted.filter((b) => b.workerId === JHON);
    expect(jhon).toHaveLength(2);
    expect(jhon[0].id).not.toBe(jhon[1].id);
  }, 20000);

  it("refuses a box that is not a number, and writes nothing", async () => {
    signIn();
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await user.type(await screen.findByLabelText("Jhon Fredy Cardona Loaiza, kilos"), "abc");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText(/Revise los kilos de Jhon Fredy Cardona Loaiza/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posted).toHaveLength(0);
  }, 20000);

  it("warns before saving a pesada no one can carry", async () => {
    signIn();
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await user.type(await screen.findByLabelText("Jhon Fredy Cardona Loaiza, kilos"), "420");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Revise que no sobre un cero/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Revisar" }));
    expect(posted).toHaveLength(0);
  }, 20000);

  it("opens on today and moves to another day with one tap", async () => {
    signIn();
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?lote=${ALTO}`);
    expect(await screen.findByText(/^Hoy, /)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ir a hoy" })).toBeNull();
    const monday = screen
      .getAllByRole("button", { pressed: false })
      .find((b) => /^Lunes /.test(b.getAttribute("aria-label") ?? ""));
    if (monday) {
      await user.click(monday);
      expect(await screen.findByRole("button", { name: "Ir a hoy" })).toBeInTheDocument();
    }
  }, 20000);

  it("keeps the old weekly link working", async () => {
    signIn();
    renderApp(`/cosecha/registrar-semana?lunes=${DAY}&lote=${ALTO}`);
    expect(await screen.findByRole("heading", { name: "Registro de recolección masivo" })).toBeInTheDocument();
    expect(await screen.findByText("Lunes 24 de agosto")).toBeInTheDocument();
  }, 20000);
});

/** Adds one pesada for Jhon on DAY through the screen, and waits for it. */
async function addForJhon(user: ReturnType<typeof userEvent.setup>, kilos: string) {
  await user.type(await screen.findByLabelText("Jhon Fredy Cardona Loaiza, kilos"), kilos);
  await user.click(screen.getByRole("button", { name: "Guardar" }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Sí, guardar" }));
  await screen.findByText(/Se agregó 1 pesada nueva/, {}, { timeout: 5000 });
}

/** A harvest pesada as the screen reads it, for the settled-week cases. */
function pesada(over: Partial<WorkRecord> & Pick<WorkRecord, "id" | "workerId" | "quantity" | "settled">): WorkRecord {
  return {
    workerName: "", activityId: "", activityName: "Recolección", category: "cosecha" as never,
    payMode: "work_unit" as never, unitLabel: "kg", plotIds: [ALTO], plotNames: ["Alto"],
    plotCropIds: [], plotCropNames: [], dateFrom: DAY, dateTo: DAY, rateCents: null,
    estimatedAmountCents: null, amountIsEstimate: null, note: null, status: "active",
    ...over,
  } as WorkRecord;
}

describe("Registro masivo on an earlier day", () => {
  it("loads what the day already has and lets the owner correct it", async () => {
    signIn();
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    expect(await screen.findByText("Lunes 24 de agosto")).toBeInTheDocument();
    await addForJhon(user, "30");
    const created = posted[0].id;

    // The row offers «Corregir», and the box is still open for another pesada.
    const card = screen.getByLabelText("Jhon Fredy Cardona Loaiza, kilos").closest(".MuiCard-root") as HTMLElement;
    expect(screen.getByLabelText("Jhon Fredy Cardona Loaiza, kilos")).toBeEnabled();
    await user.click(within(card).getByRole("button", { name: "Corregir las pesadas de Jhon Fredy Cardona Loaiza" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Corregir pesadas")).toBeInTheDocument();
    expect(within(dialog).getByText(/Lunes 24 de agosto/)).toBeInTheDocument();
    const boxes = within(dialog).getAllByLabelText(/^Pesada \d+, kilos$/);
    const mine = boxes.find((b) => (b as HTMLInputElement).value === "30") as HTMLInputElement;
    expect(mine).toBeDefined();
    await user.clear(mine);
    await user.type(mine, "32");
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));

    expect(await screen.findByText(/Se corrigió 1 pesada de Jhon Fredy Cardona Loaiza/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(patched).toEqual([{ id: created, body: { quantity: 32 } }]);
    expect(posted).toHaveLength(1);
  }, 20000);

  it("takes a pesada out from «Corregir»", async () => {
    signIn();
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await addForJhon(user, "27");
    const created = posted[0].id;
    await user.click(screen.getByRole("button", { name: "Corregir las pesadas de Jhon Fredy Cardona Loaiza" }));
    const dialog = await screen.findByRole("dialog");
    const boxes = within(dialog).getAllByLabelText(/^Pesada \d+, kilos$/);
    const n = boxes.findIndex((b) => (b as HTMLInputElement).value === "27") + 1;
    await user.click(within(dialog).getByRole("button", { name: `Quitar la pesada ${n}` }));
    expect(within(dialog).getByText(/Se quita · era 27 kg/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));
    await screen.findByText(/Se corrigió 1 pesada/, {}, { timeout: 5000 });
    expect(patched).toEqual([{ id: created, body: { status: "inactive" } }]);
  }, 20000);

  it("asks before moving to another day with kilos typed, and never carries them over", async () => {
    signIn();
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await user.type(await screen.findByLabelText("Jhon Fredy Cardona Loaiza, kilos"), "12");
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Martes 25 de agosto" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Lunes 24 de agosto")).toBeInTheDocument();
    expect(screen.getByLabelText("Jhon Fredy Cardona Loaiza, kilos")).toHaveValue("12");

    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole("button", { name: "Martes 25 de agosto" }));
    expect(await screen.findByText("Martes 25 de agosto")).toBeInTheDocument();
    expect(await screen.findByLabelText("Jhon Fredy Cardona Loaiza, kilos")).toHaveValue("");
  }, 20000);

  it("keeps a settled week read-only and says why, plainly", async () => {
    vi.spyOn(api, "listWorkRecords").mockResolvedValue([
      pesada({ id: "s1", workerId: JHON, quantity: 40, settled: true }),
    ]);
    signIn();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    expect(await screen.findByText("Esta semana ya se liquidó, no se puede cambiar.")).toBeInTheDocument();
    for (const box of await screen.findAllByLabelText(/, kilos$/)) expect(box).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Corregir/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
    // What was registered is still there to read.
    expect(soFarOf(/Jhon Fredy Cardona Loaiza, kilos/)).toEqual({ count: 1, kilos: 40 });
  }, 20000);

  it("locks only the people already settled when the rest of the week is open", async () => {
    const MARIA_ROW = /^María .*, kilos$/;
    signIn();
    const probe = renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    const mariaId = await (async () => {
      await screen.findByLabelText(MARIA_ROW);
      const workers = await api.listWorkers({ status: "active" });
      return workers.find((w) => w.name.startsWith("María"))!.id;
    })();
    probe.unmount();

    vi.spyOn(api, "listWorkRecords").mockResolvedValue([
      pesada({ id: "s1", workerId: JHON, quantity: 40, settled: true, dateFrom: "2026-08-25", dateTo: "2026-08-25" }),
      pesada({ id: "o1", workerId: mariaId, quantity: 22, settled: false }),
    ]);
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    expect(await screen.findByText(/A 1 persona ya se le liquidó esta semana/)).toBeInTheDocument();
    expect(screen.queryByText("Esta semana ya se liquidó, no se puede cambiar.")).toBeNull();
    // Jhon: settled on the Tuesday, so his Monday is locked too.
    expect(screen.getByLabelText("Jhon Fredy Cardona Loaiza, kilos")).toBeDisabled();
    const jhonCard = screen.getByLabelText("Jhon Fredy Cardona Loaiza, kilos").closest(".MuiCard-root") as HTMLElement;
    expect(within(jhonCard).getByText("Semana liquidada: no se puede cambiar")).toBeInTheDocument();
    // María: open, can add and correct.
    expect(screen.getByLabelText(MARIA_ROW)).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Corregir las pesadas de María/ })).toBeInTheDocument();
  }, 20000);
});

describe("Registro masivo: «Buscar por nombre»", () => {
  /** The people whose kilos box is on screen, by name. */
  const shownNames = () =>
    screen.queryAllByLabelText(/, kilos$/).map((el) => (el.getAttribute("aria-label") ?? "").replace(/, kilos$/, ""));

  it("sits next to the lote and narrows the list as you type, ignoring accents and case", async () => {
    signIn();
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await screen.findByLabelText("Jhon Fredy Cardona Loaiza, kilos");
    const all = shownNames();
    expect(all.length).toBeGreaterThan(2);
    const search = screen.getByRole("textbox", { name: "Buscar por nombre" });
    expect(search).toHaveAttribute("placeholder", "Buscar por nombre o canasto");

    // «marin» finds «Édinson Marín Ríos»; so does «EDINSON».
    await user.type(search, "marin");
    expect(shownNames()).toEqual(["Édinson Marín Ríos"]);
    expect(screen.getByText(`1 persona de ${all.length}`)).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "EDINSON");
    expect(shownNames()).toEqual(["Édinson Marín Ríos"]);

    // Any part of a last name: both Ospinas.
    await user.clear(search);
    await user.type(search, "ospina");
    expect(shownNames().sort()).toEqual(["Luz Dary Ospina Giraldo", "María Restrepo Ospina"]);

    // Nobody: said plainly. People who left the farm are not offered.
    await user.clear(search);
    await user.type(search, "nubia");
    expect(shownNames()).toEqual([]);
    expect(screen.getByText("No hay nadie con ese nombre o canasto")).toBeInTheDocument();

    // The clear button brings everyone back and leaves the search ready.
    await user.click(screen.getByRole("button", { name: "Borrar la búsqueda" }));
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(shownNames()).toEqual(all);
  }, 20000);

  it("keeps kilos typed for someone hidden by the search", async () => {
    signIn();
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await user.type(await screen.findByLabelText("Jhon Fredy Cardona Loaiza, kilos"), "12");
    await user.type(screen.getByRole("textbox", { name: "Buscar por nombre" }), "marin");
    expect(screen.queryByLabelText("Jhon Fredy Cardona Loaiza, kilos")).toBeNull();
    expect(screen.getByText("1 pesada nueva sin guardar")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ver a todos" }));
    expect(screen.getByLabelText("Jhon Fredy Cardona Loaiza, kilos")).toHaveValue("12");
  }, 20000);

  it("finds a person, takes the kilos, saves, and is ready for the next one — all from the keyboard", async () => {
    signIn();
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await screen.findByLabelText("Jhon Fredy Cardona Loaiza, kilos");
    const search = screen.getByRole("textbox", { name: "Buscar por nombre" });

    // Enter picks the first match and moves to its kilos.
    await user.type(search, "cardona{Enter}");
    const kilos = screen.getByLabelText("Jhon Fredy Cardona Loaiza, kilos");
    expect(kilos).toHaveFocus();

    // Enter in the kilos asks to save; Enter again says «Sí, guardar».
    await user.keyboard("22{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Jhon Fredy Cardona Loaiza: 22 kg/)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Sí, guardar" })).toHaveFocus());
    await user.keyboard("{Enter}");

    expect(await screen.findByText(/Se agregó 1 pesada nueva/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(posted).toEqual([expect.objectContaining({ workerId: JHON, quantity: 22, dateFrom: DAY, plotIds: [ALTO] })]);
    // The search is empty, everyone is back, and the cursor waits for the next name.
    await waitFor(() => expect(search).toHaveFocus());
    expect(search).toHaveValue("");
    expect(screen.getByLabelText(/^María .*, kilos$/)).toBeInTheDocument();
  }, 20000);

  it("does nothing on Enter when nobody matches", async () => {
    signIn();
    const user = userEvent.setup();
    renderApp(`/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`);
    await screen.findByLabelText("Jhon Fredy Cardona Loaiza, kilos");
    const search = screen.getByRole("textbox", { name: "Buscar por nombre" });
    await user.type(search, "zzz{Enter}");
    expect(search).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 20000);
});

describe("bulk helpers", () => {
  const w = (id: string, name: string) => ({ id, name, lastName: "" }) as unknown as Worker;
  const people = [w("a", "Ana"), w("b", "Beto"), w("c", "Carla")];

  it("turns only the filled boxes into new pesadas", () => {
    const { entries, errors } = bulkEntries(people, { a: "20", b: "  ", c: "15,5" });
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      { workerId: "a", name: "Ana", quantity: 20 },
      { workerId: "c", name: "Carla", quantity: 15.5 },
    ]);
  });

  it("names the person whose kilos are wrong", () => {
    expect(bulkEntries(people, { b: "x" }).errors[0]).toMatch(/Beto/);
    expect(bulkEntries(people, { b: "0" }).errors[0]).toMatch(/más de cero/);
  });

  it("adds up what each person already has on the day", () => {
    const r = (workerId: string, quantity: number) => ({ workerId, quantity }) as never;
    const s = registeredByWorker([r("a", 20), r("a", 18), r("b", 5)]);
    expect(soFarLabel(s.a, String)).toBe("2 pesadas · 38 kg");
    expect(soFarLabel(s.b, String)).toBe("1 pesada · 5 kg");
    expect(s.c).toBeUndefined();
  });


  it("folds names for searching: no accents, no case, single spaces", () => {
    expect(foldName("  RAMÍREZ   Peña ")).toBe("ramirez pena");
  });

  it("matches any part of the first or last names, word by word", () => {
    const pedro = { id: "p", name: "Pedro", lastName: "Ramírez" } as unknown as Worker;
    expect(matchesName(pedro, "ramirez")).toBe(true);
    expect(matchesName(pedro, "PED")).toBe(true);
    expect(matchesName(pedro, "mír")).toBe(true);
    expect(matchesName(pedro, "pedro ram")).toBe(true);
    expect(matchesName(pedro, "ram pedro")).toBe(true);
    expect(matchesName(pedro, "pablo")).toBe(false);
    expect(matchesName(pedro, "   ")).toBe(true);
    const list = [pedro, { id: "a", name: "Ana", lastName: "Pérez" } as unknown as Worker];
    expect(filterWorkers(list, "pe").map((x) => x.id)).toEqual(["p", "a"]);
    expect(filterWorkers(list, "perez").map((x) => x.id)).toEqual(["a"]);
    expect(filterWorkers(list, "")).toEqual(list);
  });

  it("knows whose week is settled, and when the whole week is", () => {
    const r = (workerId: string, settled: boolean) => ({ workerId, settled }) as never;
    expect(weekLocks([])).toEqual({ settledWorkers: new Set(), weekSettled: false });
    const some = weekLocks([r("a", true), r("a", false), r("b", false)]);
    expect([...some.settledWorkers]).toEqual(["a"]);
    expect(some.weekSettled).toBe(false);
    expect(weekLocks([r("a", true), r("b", true), r("b", false)]).weekSettled).toBe(true);
  });

  it("turns «Corregir» into changes, skipping what did not change and what is settled", () => {
    const r = (id: string, quantity: number, settled = false) => ({ id, quantity, settled }) as never;
    const records = [r("x", 20), r("y", 15.5), r("z", 10), r("s", 30, true)];
    expect(plannedCorrections(records, { x: "20", y: "15,5", z: "10", s: "99" }, {})).toEqual({ corrections: [], errors: [] });
    expect(plannedCorrections(records, { x: "22", y: "15,5", z: "10" }, { z: true, s: true })).toEqual({
      corrections: [{ kind: "update", recordId: "x", quantity: 22 }, { kind: "remove", recordId: "z" }],
      errors: [],
    });
    expect(plannedCorrections(records, { x: "", y: "abc", z: "0" }, {}).errors).toEqual([
      "Escriba los kilos de la pesada 1, o toque «Quitar».",
      "Revise la pesada 2: «abc» no es un número.",
      "Revise la pesada 3: deben ser más de cero.",
    ]);
  });

  it("says the day in words", () => {
    expect(dayTitle("2026-09-26", "2026-09-26")).toBe("Hoy, sábado 26 de septiembre");
    expect(dayTitle("2026-09-25", "2026-09-26")).toBe("Ayer, viernes 25 de septiembre");
    expect(dayTitle("2026-09-22", "2026-09-26")).toBe("Martes 22 de septiembre");
  });
});
