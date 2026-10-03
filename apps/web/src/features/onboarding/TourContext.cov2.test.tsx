// SPDX-License-Identifier: MIT
/**
 * The tour context's quieter paths: a corrupt local copy, a load that fails
 * after the page is gone, rows for tours this app does not know, a handover
 * that fails again, a tour started by hand while the load is still out, and
 * the no-op «resume» outside a provider.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TourProvider, useTour, useTourAction } from "./TourContext";

const listTours = vi.fn();
const saveTour = vi.fn();

vi.mock("../../api/endpoints", () => ({
  api: {
    listTours: (...a: unknown[]) => listTours(...a),
    saveTour: (...a: unknown[]) => saveTour(...a),
  },
}));

type User = { id: string; isSuperAdmin: boolean; farm: { id: string; name: string } };
const AUTH = vi.hoisted(() => ({
  value: {
    user: null as User | null,
    principal: { role: "owner", isSuperAdmin: false, farmStatus: "active" },
    readOnly: false,
  },
}));

vi.mock("../../auth/AuthContext", () => ({ useAuth: () => AUTH.value }));

const STORAGE_NAME = "bascula.tours.u-cov2.La Palma";

function Probe() {
  const t = useTour();
  return (
    <>
      <div data-testid="current">{t.current ? `${t.current.tour}:${t.current.n}` : "none"}</div>
      <div data-testid="loaded">{String(t.loaded)}</div>
      <div data-testid="owner">{t.saved.owner ? `${t.saved.owner.status}:${t.saved.owner.step}` : "-"}</div>
      <button onClick={() => t.start("owner")}>Empezar</button>
      <button onClick={() => t.start("owner", 3)}>Ir al paso 3</button>
      <button onClick={() => t.resume("owner")}>Continuar</button>
      <button
        onClick={() => {
          void t.runAction("guardar").then((ok) => {
            document.body.dataset.guardar = String(ok);
          });
        }}
      >
        Guardar
      </button>
    </>
  );
}

function Action({ ok }: { ok: boolean }) {
  useTourAction("guardar", () => ok);
  return null;
}

const text = (id: string) => screen.getByTestId(id).textContent;
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_NAME);
  listTours.mockReset();
  saveTour.mockReset();
  saveTour.mockResolvedValue({});
  AUTH.value = {
    user: { id: "u-cov2", isSuperAdmin: false, farm: { id: "f-1", name: "La Palma" } },
    principal: { role: "owner", isSuperAdmin: false, farmStatus: "active" },
    readOnly: false,
  };
  delete document.body.dataset.guardar;
});

const mount = (extra: React.ReactNode = null) =>
  render(
    <TourProvider>
      <Probe />
      {extra}
    </TourProvider>,
  );

describe("TourProvider", () => {
  it("resumes an owner tour never saved from its welcome", async () => {
    AUTH.value.principal.role = "administrator";
    listTours.mockResolvedValue([]);
    mount();
    await waitFor(() => expect(text("loaded")).toBe("true"));
    click("Continuar");
    expect(text("current")).toBe("owner:0");
  });

  it("reads a corrupt local copy as nothing when the server cannot be reached", async () => {
    localStorage.setItem(STORAGE_NAME, "{no es json");
    listTours.mockRejectedValue(new Error("offline"));
    const view = mount();
    await waitFor(() => expect(text("loaded")).toBe("true"));
    expect(text("owner")).toBe("-");
    expect(text("current")).toBe("none");
    view.unmount();
  });

  it("saves to the server alone when nobody is signed in", async () => {
    AUTH.value.user = null;
    mount();
    click("Empezar");
    await act(async () => {});
    expect(saveTour).toHaveBeenCalledWith("owner", 0, "active");
    expect(localStorage.getItem(STORAGE_NAME)).toBeNull();
  });

  it("does nothing with a load that fails after the page is gone", async () => {
    const d = deferred<never>();
    listTours.mockReturnValue(d.promise);
    const view = mount();
    view.unmount();
    d.reject(new Error("offline"));
    await act(async () => {});
    expect(saveTour).not.toHaveBeenCalled();
  });

  it("ignores rows for tours it does not know, and keeps a pending save when the handover fails", async () => {
    localStorage.setItem(STORAGE_NAME, JSON.stringify({ owner: { step: 4, status: "later", pending: true } }));
    listTours.mockResolvedValue([{ tour: "otro", step: 9, status: "done" }]);
    saveTour.mockRejectedValue(new Error("offline"));
    mount();
    await waitFor(() => expect(text("loaded")).toBe("true"));
    expect(text("owner")).toBe("later:4");
    await act(async () => {});
    expect(JSON.parse(localStorage.getItem(STORAGE_NAME)!).owner.pending).toBe(true);
    expect(text("current")).toBe("none");
  });

  it("does not start a tour by itself over one started by hand while loading, nor restart a running one", async () => {
    const d = deferred<unknown[]>();
    listTours.mockReturnValue(d.promise);
    mount();
    click("Empezar");
    expect(text("current")).toBe("owner:0");
    // A second start of the same tour keeps where this run began.
    click("Ir al paso 3");
    expect(text("current")).toBe("owner:3");
    d.resolve([]);
    await waitFor(() => expect(text("loaded")).toBe("true"));
    expect(text("current")).toBe("owner:3");
  });

  it("keeps the newer page action when an older one unmounts", async () => {
    listTours.mockResolvedValue([{ tour: "owner", step: 12, status: "done" }]);
    const view = mount(<Action key="vieja" ok />);
    await waitFor(() => expect(text("loaded")).toBe("true"));
    view.rerender(
      <TourProvider>
        <Probe />
        <Action key="vieja" ok />
        <Action key="nueva" ok={false} />
      </TourProvider>,
    );
    // The older one goes; the newer registration must survive its cleanup.
    view.rerender(
      <TourProvider>
        <Probe />
        <Action key="nueva" ok={false} />
      </TourProvider>,
    );
    click("Guardar");
    await waitFor(() => expect(document.body.dataset.guardar).toBe("false"));
  });
});

describe("outside a provider", () => {
  it("«resume» does nothing", () => {
    render(<Probe />);
    click("Continuar");
    expect(text("current")).toBe("none");
  });
});
