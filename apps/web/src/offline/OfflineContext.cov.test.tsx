/**
 * The offline provider on its own: signal coming and going, the tab coming
 * back to the front, the 30-second retry, uploads that fail or finish after
 * the screen is gone, and the no-op a screen gets outside the provider.
 *
 * Storage and the upload queue are replaced so each transition can be driven
 * one step at a time; the end-to-end path through IndexedDB is in
 * offline.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { PendingWeighing } from "./store";
import type { FlushResult } from "./queue";

const m = vi.hoisted(() => ({
  user: { farm: { id: "farm-1" } } as { farm: { id: string } | null } | null,
  storage: true,
  listPending: vi.fn<(farmId: string) => Promise<PendingWeighing[]>>(),
  deletePending: vi.fn<(id: string) => Promise<void>>(),
  flushPending: vi.fn<(farmId: string) => Promise<FlushResult>>(),
  enqueue: vi.fn<(p: unknown) => Promise<void>>(),
}));

vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: m.user }) }));
vi.mock("./store", () => ({
  listPending: (f: string) => m.listPending(f),
  deletePending: (id: string) => m.deletePending(id),
  storageAvailable: () => m.storage,
}));
vi.mock("./queue", () => ({
  flushPending: (f: string) => m.flushPending(f),
  enqueue: (p: unknown) => m.enqueue(p),
}));

import { OfflineProvider, useOffline } from "./OfflineContext";

// Long user flows; the coverage run on a loaded machine is slow.
vi.setConfig({ testTimeout: 30_000 });

function weighing(id: string, error: string | null = null): PendingWeighing {
  return {
    id,
    farmId: "farm-1",
    input: {} as PendingWeighing["input"],
    who: "Ana",
    plot: "El Alto",
    kg: 10,
    day: "2026-09-25",
    createdAt: "2026-09-25T10:00:00Z",
    error,
  };
}

function Probe() {
  const o = useOffline();
  const [msg, setMsg] = useState("");
  return (
    <div>
      <p>{o.online ? "Con señal" : "Sin señal"}</p>
      <p>{`Por subir: ${o.pending.length}`}</p>
      <p>{o.syncing ? "Subiendo" : "Quieto"}</p>
      <p>{o.canQueue ? "Puede guardar" : "No puede guardar"}</p>
      <p>{msg}</p>
      <button
        onClick={() =>
          o
            .enqueue({ id: "n1", input: {} as PendingWeighing["input"], who: "Ana", plot: "El Alto", kg: 5, day: "2026-09-25" })
            .then(() => setMsg("Guardada"))
            .catch((e: Error) => setMsg(e.message))
        }
      >
        Guardar
      </button>
      <button onClick={() => void o.remove("w1").then(() => setMsg("Borrada"))}>Borrar</button>
      <button
        onClick={() => {
          void Promise.all([o.flush(), o.flush()]).then(([a, b]) =>
            setMsg(`primera ${a ? a.sent : "nada"}, segunda ${b ? b.sent : "nada"}`),
          );
        }}
      >
        Subir dos veces
      </button>
    </div>
  );
}

function renderProvider() {
  return render(
    <OfflineProvider>
      <Probe />
    </OfflineProvider>,
  );
}

const NOTHING: FlushResult = { sent: 0, refused: 0, stopped: false };

beforeEach(() => {
  m.user = { farm: { id: "farm-1" } };
  m.storage = true;
  m.listPending.mockReset().mockResolvedValue([]);
  m.deletePending.mockReset().mockResolvedValue(undefined);
  m.flushPending.mockReset().mockResolvedValue(NOTHING);
  m.enqueue.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OfflineProvider — signal transitions", () => {
  it("goes offline and back online, uploading when the signal returns", async () => {
    renderProvider();
    await waitFor(() => expect(m.flushPending).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Con señal")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByText("Sin señal")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.getByText("Con señal")).toBeInTheDocument();
    await waitFor(() => expect(m.flushPending).toHaveBeenCalledTimes(2));
  });

  it("uploads when the tab comes back to the front, not when it goes away", async () => {
    renderProvider();
    await waitFor(() => expect(m.flushPending).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Quieto")).toBeInTheDocument());

    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(m.flushPending).toHaveBeenCalledTimes(1);

    state.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(m.flushPending).toHaveBeenCalledTimes(2));
  });

  it("marks itself online after an upload that sent something", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    m.flushPending.mockResolvedValue({ sent: 1, refused: 0, stopped: false });
    renderProvider();
    expect(screen.getByText("Sin señal")).toBeInTheDocument();
    expect(await screen.findByText("Con señal")).toBeInTheDocument();
  });

  it("assumes signal where there is no navigator to ask", () => {
    vi.stubGlobal("navigator", undefined);
    m.user = null;
    renderProvider();
    expect(screen.getByText("Con señal")).toBeInTheDocument();
  });
});

describe("OfflineProvider — the queue", () => {
  it("retries every 30 seconds while something is waiting, and not for refused ones", async () => {
    const timers: (() => void)[] = [];
    const real = window.setInterval.bind(window);
    // Catch the 30-second retry; every other interval (Testing Library's own
    // polling) runs for real.
    const spy = vi.spyOn(window, "setInterval").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms === 30_000) {
        timers.push(fn);
        return 0;
      }
      return real(fn, ms);
    }) as unknown as typeof window.setInterval);
    m.listPending.mockResolvedValue([weighing("w1"), weighing("w2", "Lote cerrado")]);
    renderProvider();
    expect(await screen.findByText("Por subir: 2")).toBeInTheDocument();
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.any(Function), 30_000));
    const before = m.flushPending.mock.calls.length;
    await act(async () => {
      timers[timers.length - 1]();
    });
    await waitFor(() => expect(m.flushPending.mock.calls.length).toBe(before + 1));
  });

  it("keeps one upload at a time", async () => {
    const user = userEvent.setup();
    renderProvider();
    await waitFor(() => expect(m.flushPending).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Quieto")).toBeInTheDocument());
    m.flushPending.mockResolvedValue({ sent: 2, refused: 0, stopped: false });
    await user.click(screen.getByRole("button", { name: "Subir dos veces" }));
    expect(await screen.findByText("primera 2, segunda nada")).toBeInTheDocument();
  });

  it("treats an upload that throws as nothing uploaded", async () => {
    const user = userEvent.setup();
    renderProvider();
    await waitFor(() => expect(m.flushPending).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Quieto")).toBeInTheDocument());
    m.flushPending.mockRejectedValue(new Error("boom"));
    await user.click(screen.getByRole("button", { name: "Subir dos veces" }));
    expect(await screen.findByText("primera nada, segunda nada")).toBeInTheDocument();
    expect(screen.getByText("Quieto")).toBeInTheDocument();
  });

  it("stores a weighing and lists it again", async () => {
    const user = userEvent.setup();
    renderProvider();
    await waitFor(() => expect(m.flushPending).toHaveBeenCalled());
    m.listPending.mockResolvedValue([weighing("n1")]);
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Guardada")).toBeInTheDocument();
    expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: "n1", farmId: "farm-1" }));
    expect(await screen.findByText("Por subir: 1")).toBeInTheDocument();
  });

  it("removes a weighing and lists what is left", async () => {
    const user = userEvent.setup();
    m.listPending.mockResolvedValue([weighing("w1")]);
    renderProvider();
    expect(await screen.findByText("Por subir: 1")).toBeInTheDocument();
    m.listPending.mockResolvedValue([]);
    await user.click(screen.getByRole("button", { name: "Borrar" }));
    expect(await screen.findByText("Borrada")).toBeInTheDocument();
    expect(m.deletePending).toHaveBeenCalledWith("w1");
    expect(await screen.findByText("Por subir: 0")).toBeInTheDocument();
  });

  it("refuses to store a weighing with no farm, and never uploads", async () => {
    const user = userEvent.setup();
    m.user = { farm: null };
    renderProvider();
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Sin finca")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Subir dos veces" }));
    expect(await screen.findByText("primera nada, segunda nada")).toBeInTheDocument();
    expect(m.listPending).not.toHaveBeenCalled();
    expect(m.flushPending).not.toHaveBeenCalled();
  });

  it("does nothing with storage where the browser has none", async () => {
    m.storage = false;
    renderProvider();
    expect(screen.getByText("No puede guardar")).toBeInTheDocument();
    await act(async () => {});
    expect(m.listPending).not.toHaveBeenCalled();
    expect(m.flushPending).not.toHaveBeenCalled();
  });

  it("does not touch state when an upload finishes after the screen is gone", async () => {
    let finish: (r: FlushResult) => void = () => {};
    m.flushPending.mockImplementation(
      () =>
        new Promise<FlushResult>((r) => {
          finish = r;
        }),
    );
    const err = vi.spyOn(console, "error");
    const { unmount } = renderProvider();
    await waitFor(() => expect(m.flushPending).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      finish({ sent: 1, refused: 0, stopped: false });
    });
    // No refresh after the provider is gone.
    expect(m.listPending).toHaveBeenCalledTimes(1);
    expect(err).not.toHaveBeenCalled();
  });

  it("ignores a list that arrives after the screen is gone", async () => {
    let finish: (l: PendingWeighing[]) => void = () => {};
    m.listPending.mockImplementation(
      () =>
        new Promise<PendingWeighing[]>((r) => {
          finish = r;
        }),
    );
    const { unmount } = renderProvider();
    await waitFor(() => expect(m.listPending).toHaveBeenCalled());
    unmount();
    await act(async () => {
      finish([weighing("w1")]);
    });
    expect(screen.queryByText("Por subir: 1")).not.toBeInTheDocument();
  });

  it("treats storage that will not open as nothing stored", async () => {
    m.listPending.mockRejectedValue(new Error("blocked"));
    renderProvider();
    await waitFor(() => expect(m.flushPending).toHaveBeenCalled());
    expect(screen.getByText("Por subir: 0")).toBeInTheDocument();
  });
});

describe("useOffline outside the provider", () => {
  it("is a no-op that cannot store anything", async () => {
    const user = userEvent.setup();
    render(<Probe />);
    expect(screen.getByText("Con señal")).toBeInTheDocument();
    expect(screen.getByText("No puede guardar")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Sin almacenamiento en este dispositivo")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Borrar" }));
    expect(await screen.findByText("Borrada")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Subir dos veces" }));
    expect(await screen.findByText("primera nada, segunda nada")).toBeInTheDocument();
  });
});
