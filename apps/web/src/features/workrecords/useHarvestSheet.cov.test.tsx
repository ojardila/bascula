// SPDX-License-Identifier: MIT
/**
 * The harvest sheet's state on its own: what it says when the catalogues or
 * the sheet cannot load, a sheet that changed under a slow answer, and every
 * kind of write (new, changed, cleared) with who may make it.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { delay, http, HttpResponse } from "msw";
import { AuthProvider, useAuth } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";
import { useHarvestSheet } from "./useHarvestSheet";
import { cellKey } from "./planilla";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const WEIGHER = "0192f3a0-0001-7000-8000-000000000003";

function signIn(userId = OWNER) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <AuthProvider>{children}</AuthProvider>
    </MemoryRouter>
  );
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const now = new Date();
const DAY1 = iso(new Date(now.getTime() - 2 * 86_400_000));
const DAY2 = iso(new Date(now.getTime() - 1 * 86_400_000));
const DAYS = [DAY1, DAY2];
const TODAY = iso(now);

const plotNamed = (name: string) =>
  db.tenantOf(db.FARM_ID)!.plots.find((p) => p.name === name)!.id;

function renderSheet(plotId: string, days = DAYS) {
  return renderHook(
    ({ pid }: { pid: string }) => ({
      sheet: useHarvestSheet({ days, plotId: pid, today: TODAY, intentTag: "dia" }),
      auth: useAuth(),
    }),
    { wrapper, initialProps: { pid: plotId } },
  );
}

type View = ReturnType<typeof renderSheet>;

async function ready(view: View) {
  await waitFor(() => {
    expect(view.result.current.auth.user).not.toBeNull();
    expect(view.result.current.sheet.plot).not.toBeNull();
    expect(view.result.current.sheet.loadingSheet).toBe(false);
  });
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  signIn();
});

describe("loading", () => {
  it("is denied when the catalogues are refused for permission", async () => {
    server.use(
      http.get("*/v1/workers", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no", details: {} } },
          { status: 403 },
        ),
      ),
    );
    const view = renderSheet(plotNamed("El Alto"));
    await waitFor(() => expect(view.result.current.sheet.denied).toBe(true));
    expect(view.result.current.sheet.loadError).toBeNull();
  });

  it("says why the sheet itself could not load", async () => {
    server.use(
      http.get("*/v1/work-records", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "falló", details: {} } },
          { status: 500 },
        ),
      ),
    );
    const view = renderSheet(plotNamed("El Alto"));
    await waitFor(() => expect(view.result.current.sheet.loadError).toBeTruthy());
  });

  it("ignores a slow answer for a lote that is no longer on screen", async () => {
    let calls = 0;
    server.use(
      http.get("*/v1/work-records", async () => {
        calls += 1;
        if (calls === 1) {
          await delay(150);
          return HttpResponse.json({ items: [] });
        }
        return undefined;
      }),
    );
    const alto = plotNamed("El Alto");
    const cuchilla = plotNamed("La Cuchilla");
    const view = renderSheet(alto);
    await waitFor(() => expect(calls).toBe(1));
    view.rerender({ pid: cuchilla });
    await ready(view);
    expect(view.result.current.sheet.plot?.id).toBe(cuchilla);
    await act(async () => {
      await delay(200);
    });
    expect(view.result.current.sheet.loadingSheet).toBe(false);
    expect(view.result.current.sheet.loadError).toBeNull();
  });

  it("ignores a slow failure for a lote that is no longer on screen", async () => {
    let calls = 0;
    server.use(
      http.get("*/v1/work-records", async () => {
        calls += 1;
        if (calls === 1) {
          await delay(150);
          return HttpResponse.json(
            { error: { code: "INTERNAL", message: "falló", details: {} } },
            { status: 500 },
          );
        }
        return undefined;
      }),
    );
    const view = renderSheet(plotNamed("El Alto"));
    await waitFor(() => expect(calls).toBe(1));
    view.rerender({ pid: plotNamed("La Cuchilla") });
    await ready(view);
    await act(async () => {
      await delay(200);
    });
    expect(view.result.current.sheet.loadError).toBeNull();
  });
});

describe("saving", () => {
  it("writes nothing before the catalogues arrive", async () => {
    const view = renderSheet(plotNamed("El Alto"));
    let wrote = true;
    await act(async () => {
      wrote = await view.result.current.sheet.save();
    });
    expect(wrote).toBe(false);
    await ready(view);
  });

  it("creates, changes and clears weighings, and says when nothing changed", async () => {
    const view = renderSheet(plotNamed("El Alto"));
    await ready(view);
    const [a, b] = view.result.current.sheet.workers!;

    // A cell the sheet never had (somebody outside it) starts empty.
    act(() => view.result.current.sheet.setCell("nadie", DAY1, "3"));
    expect(view.result.current.sheet.cells[cellKey("nadie", DAY1)].text).toBe("3");

    // Something that is not a number stops the whole save.
    act(() => view.result.current.sheet.setCell(a.id, DAY1, "abc"));
    let wrote = true;
    await act(async () => {
      wrote = await view.result.current.sheet.save();
    });
    expect(wrote).toBe(false);
    expect(view.result.current.sheet.saveError).toMatch(/no es un número/);

    act(() => view.result.current.sheet.setCell(a.id, DAY1, "10"));
    act(() => view.result.current.sheet.setCell(b.id, DAY1, "20"));
    expect(view.result.current.sheet.dirty).toBe(true);
    await act(async () => {
      wrote = await view.result.current.sheet.save();
    });
    expect(wrote).toBe(true);
    expect(view.result.current.sheet.saved).toBe("Se guardaron 2 pesadas.");
    expect(view.result.current.sheet.cells[cellKey(a.id, DAY1)].recordId).toBeTruthy();

    // Change one and clear the other.
    act(() => view.result.current.sheet.setCell(a.id, DAY1, "12"));
    act(() => view.result.current.sheet.setCell(b.id, DAY1, ""));
    await act(async () => {
      wrote = await view.result.current.sheet.save();
    });
    expect(wrote).toBe(true);
    expect(view.result.current.sheet.saved).toBe("Se guardaron 2 pesadas.");
    expect(view.result.current.sheet.cells[cellKey(a.id, DAY1)].text).toBe("12");
    expect(view.result.current.sheet.cells[cellKey(b.id, DAY1)].recordId).toBeNull();

    await act(async () => {
      wrote = await view.result.current.sheet.save();
    });
    expect(wrote).toBe(false);
    expect(view.result.current.sheet.saved).toBe("No hay cambios que guardar.");
  });

  it("keeps a weigher from changing a weighing already saved", async () => {
    signIn(WEIGHER);
    const view = renderSheet(plotNamed("El Alto"));
    await ready(view);
    const [a] = view.result.current.sheet.workers!;
    act(() => view.result.current.sheet.setCell(a.id, DAY2, "8"));
    let wrote = false;
    await act(async () => {
      wrote = await view.result.current.sheet.save();
    });
    expect(wrote).toBe(true);
    expect(view.result.current.sheet.saved).toBe("Se guardó 1 pesada.");

    act(() => view.result.current.sheet.setCell(a.id, DAY2, "9"));
    await act(async () => {
      wrote = await view.result.current.sheet.save();
    });
    expect(wrote).toBe(false);
    expect(view.result.current.sheet.saveError).toMatch(
      /no cambiar ni borrar las que ya están guardadas/,
    );
  });
});
