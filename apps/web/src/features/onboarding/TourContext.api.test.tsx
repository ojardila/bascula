/**
 * Everything the tour context offers the pages once it has loaded: starting,
 * resuming, moving, pausing, leaving it for later, dismissing, finishing, the
 * page actions the primary buttons run, and the summary notes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TourProvider, useTour, useTourAction } from "./TourContext";

const listTours = vi.fn();
const saveTour = vi.fn();

vi.mock("../../api/endpoints", () => ({
  api: {
    listTours: (...a: unknown[]) => listTours(...a),
    saveTour: (...a: unknown[]) => saveTour(...a),
  },
}));

const AUTH = vi.hoisted(() => ({
  value: {
    user: {
      id: "u-api",
      isSuperAdmin: false,
      farm: { id: "f-1", name: "La Palma" },
    } as {
      id: string;
      isSuperAdmin: boolean;
      farm: { id: string; name: string };
    } | null,
    principal: { role: "owner", isSuperAdmin: false, farmStatus: "active" },
    readOnly: false,
  },
}));

vi.mock("../../auth/AuthContext", () => ({ useAuth: () => AUTH.value }));

const KEY = "bascula.tours.u-api.La Palma";

function Probe() {
  const t = useTour();
  return (
    <>
      <div data-testid="current">
        {t.current ? `${t.current.tour}:${t.current.n}` : "none"}
      </div>
      <div data-testid="paused">{String(t.paused)}</div>
      <div data-testid="loaded">{String(t.loaded)}</div>
      <div data-testid="available">{String(t.available)}</div>
      <div data-testid="owner">
        {t.saved.owner ? `${t.saved.owner.status}:${t.saved.owner.step}` : "-"}
      </div>
      <div data-testid="weigher">
        {t.saved.weigher
          ? `${t.saved.weigher.status}:${t.saved.weigher.step}`
          : "-"}
      </div>
      <div data-testid="at3">{String(t.isAt("owner", 3))}</div>
      <div data-testid="summary">{JSON.stringify(t.summary)}</div>
      <button onClick={() => t.start("owner")}>start owner</button>
      <button onClick={() => t.start("weigher")}>start weigher</button>
      <button onClick={() => t.start("owner", 3)}>start owner 3</button>
      <button onClick={() => t.resume("owner")}>resume owner</button>
      <button onClick={() => t.resume("weigher")}>resume weigher</button>
      <button onClick={() => t.goTo(5)}>go 5</button>
      <button onClick={t.pause}>pause</button>
      <button onClick={t.later}>later</button>
      <button onClick={() => t.dismiss("owner")}>dismiss owner</button>
      <button onClick={() => t.dismiss("weigher")}>dismiss weigher</button>
      <button onClick={t.finish}>finish</button>
      <button
        onClick={() => {
          void t.runAction("save").then((ok) => {
            document.body.dataset.action = String(ok);
          });
        }}
      >
        run save
      </button>
      <button
        onClick={() => {
          void t.runAction("missing").then((ok) => {
            document.body.dataset.missing = String(ok);
          });
        }}
      >
        run missing
      </button>
      <button onClick={() => t.note({ workers: 2 } as never)}>
        note object
      </button>
      <button onClick={() => t.note(() => ({ plots: 1 }) as never)}>
        note fn
      </button>
    </>
  );
}

function SaveAction({ ok }: { ok: boolean }) {
  useTourAction("save", () => ok);
  return null;
}

const text = (id: string) => screen.getByTestId(id).textContent;
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  localStorage.removeItem(KEY);
  listTours.mockReset();
  saveTour.mockReset();
  saveTour.mockResolvedValue({});
  AUTH.value = {
    user: {
      id: "u-api",
      isSuperAdmin: false,
      farm: { id: "f-1", name: "La Palma" },
    },
    principal: { role: "owner", isSuperAdmin: false, farmStatus: "active" },
    readOnly: false,
  };
  delete document.body.dataset.action;
  delete document.body.dataset.missing;
});

async function mountDone(children: React.ReactNode = null) {
  listTours.mockResolvedValue([{ tour: "owner", step: 12, status: "done" }]);
  render(
    <TourProvider>
      <Probe />
      {children}
    </TourProvider>,
  );
  await waitFor(() => expect(text("loaded")).toBe("true"));
}

describe("the tour controls", () => {
  it("starts, moves, pauses, resumes, leaves for later and finishes", async () => {
    await mountDone();
    expect(text("current")).toBe("none");
    click("start owner");
    expect(text("current")).toBe("owner:0");
    click("go 5");
    expect(text("current")).toBe("owner:5");
    expect(saveTour).toHaveBeenLastCalledWith("owner", 5, "active");
    click("pause");
    expect(text("paused")).toBe("true");
    click("go 5");
    expect(text("paused")).toBe("false");
    click("later");
    expect(text("current")).toBe("none");
    // Watching a finished tour again: skipping keeps it finished.
    expect(text("owner")).toBe("done:12");
    click("resume owner");
    expect(text("current")).not.toBe("none");
    click("finish");
    expect(text("current")).toBe("none");
    expect(text("owner")).toBe("done:12");
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").owner.status).toBe(
      "done",
    );
  });

  it("knows which step is showing, and that a paused one is not", async () => {
    await mountDone();
    click("start owner 3");
    expect(text("at3")).toBe("true");
    click("pause");
    expect(text("at3")).toBe("false");
  });

  it("runs the weigher's tour and finishes it at its last step", async () => {
    await mountDone();
    click("start weigher");
    expect(text("current")).toBe("weigher:1");
    click("finish");
    expect(text("weigher")).toBe("done:2");
    click("resume weigher");
    expect(text("current")).toMatch(/^weigher:/);
  });

  it("resumes a tour never started from its beginning", async () => {
    await mountDone();
    click("resume weigher");
    expect(text("current")).toBe("weigher:1");
  });

  it("dismisses a tour at its saved step", async () => {
    await mountDone();
    click("dismiss owner");
    expect(text("owner")).toBe("dismissed:12");
    click("dismiss weigher");
    expect(text("weigher")).toBe("dismissed:0");
  });

  it("ignores moves, leaving and finishing when no tour is showing", async () => {
    await mountDone();
    saveTour.mockClear();
    click("go 5");
    click("later");
    click("finish");
    expect(saveTour).not.toHaveBeenCalled();
    expect(text("current")).toBe("none");
  });

  it("runs the action a page registered, and passes when none is", async () => {
    await mountDone(<SaveAction ok={false} />);
    click("run save");
    await waitFor(() => expect(document.body.dataset.action).toBe("false"));
    click("run missing");
    await waitFor(() => expect(document.body.dataset.missing).toBe("true"));
  });

  it("keeps notes for the summary", async () => {
    await mountDone();
    click("note object");
    click("note fn");
    expect(JSON.parse(text("summary") ?? "{}")).toMatchObject({
      workers: 2,
      plots: 1,
    });
  });

  it("survives a save that fails", async () => {
    saveTour.mockRejectedValue(new Error("offline"));
    await mountDone();
    click("start owner");
    await act(async () => {});
    expect(text("current")).toBe("owner:0");
  });
});

describe("who gets a tour", () => {
  it("offers the weigher's tour to a weigher", async () => {
    AUTH.value.principal.role = "weigher";
    listTours.mockResolvedValue([]);
    render(
      <TourProvider>
        <Probe />
      </TourProvider>,
    );
    await waitFor(() => expect(text("loaded")).toBe("true"));
    expect(text("available")).toBe("weigher");
  });

  it("offers none to an administrator", async () => {
    AUTH.value.principal.role = "administrator";
    listTours.mockResolvedValue([]);
    render(
      <TourProvider>
        <Probe />
      </TourProvider>,
    );
    await waitFor(() => expect(text("loaded")).toBe("true"));
    expect(text("available")).toBe("null");
    expect(text("current")).toBe("none");
  });

  it("does nothing without a signed-in user", async () => {
    AUTH.value.user = null;
    render(
      <TourProvider>
        <Probe />
      </TourProvider>,
    );
    expect(text("loaded")).toBe("false");
    expect(listTours).not.toHaveBeenCalled();
  });
});

describe("outside a provider", () => {
  it("every call is a harmless no-op", async () => {
    render(<Probe />);
    click("start owner");
    click("go 5");
    click("pause");
    click("later");
    click("dismiss owner");
    click("finish");
    click("note object");
    click("run missing");
    await waitFor(() => expect(document.body.dataset.missing).toBe("true"));
    expect(text("current")).toBe("none");
    expect(text("at3")).toBe("false");
  });
});
