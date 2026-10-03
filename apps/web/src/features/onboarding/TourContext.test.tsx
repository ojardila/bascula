// SPDX-License-Identifier: MIT
/**
 * The tour starts by itself once per user and farm, and only on the
 * server's word. A deploy restarts the API while every open page reloads
 * onto the new build; that failed load must never read as "never seen".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TourProvider, useTour, TOUR_LOAD_RETRY_MS } from "./TourContext";
import { OWNER_DONE } from "./steps";

const listTours = vi.fn();
const saveTour = vi.fn();

vi.mock("../../api/endpoints", () => ({
  api: {
    listTours: (...a: unknown[]) => listTours(...a),
    saveTour: (...a: unknown[]) => saveTour(...a),
  },
}));

const AUTH = {
  user: { id: "u-oscar", isSuperAdmin: false, farm: { id: "f-sj", name: "San José" } },
  principal: { role: "owner", isSuperAdmin: false, farmStatus: "active" },
  readOnly: false,
};

vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => AUTH,
}));

const LOCAL_KEY = "bascula.tours.u-oscar.San José";

function Probe() {
  const t = useTour();
  return (
    <>
      <div data-testid="current">{t.current ? `${t.current.tour}:${t.current.n}` : "none"}</div>
      <div data-testid="loaded">{String(t.loaded)}</div>
      <div data-testid="saved">{t.saved.owner ? `${t.saved.owner.status}:${t.saved.owner.step}` : "-"}</div>
      <button onClick={t.later}>Saltar</button>
    </>
  );
}

function mount() {
  return render(
    <TourProvider>
      <Probe />
    </TourProvider>,
  );
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const current = () => screen.getByTestId("current").textContent;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.removeItem(LOCAL_KEY);
  listTours.mockReset();
  saveTour.mockReset();
  saveTour.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the tour starting by itself", () => {
  it("starts for a user who has never seen it in this farm, and marks it as shown right away", async () => {
    listTours.mockResolvedValue([]);
    mount();
    await flush();
    expect(current()).toBe("owner:0");
    expect(saveTour).toHaveBeenCalledWith("owner", 0, "active");
  });

  it.each([
    ["done", OWNER_DONE],
    ["dismissed", 4],
    ["later", 3],
    ["active", 7],
  ] as const)("does not start again when the server already has it as %s", async (status, step) => {
    listTours.mockResolvedValue([{ tour: "owner", step, status, updatedAt: "2026-09-26T23:05:24Z" }]);
    mount();
    await flush();
    expect(screen.getByTestId("loaded").textContent).toBe("true");
    expect(current()).toBe("none");
    expect(saveTour).not.toHaveBeenCalled();
  });

  it("does not start when the server cannot be reached (a deploy restarting the API), however long it takes", async () => {
    listTours.mockRejectedValue(new Error("HTTP 502"));
    mount();
    const total = TOUR_LOAD_RETRY_MS.reduce((a, b) => a + b, 0);
    await flush(total + 1000);
    expect(listTours).toHaveBeenCalledTimes(TOUR_LOAD_RETRY_MS.length + 1);
    expect(current()).toBe("none");
    expect(saveTour).not.toHaveBeenCalled();
  });

  it("asks again after a failed load and respects what the server says: seen", async () => {
    listTours
      .mockRejectedValueOnce(new Error("HTTP 502"))
      .mockRejectedValueOnce(new Error("HTTP 503"))
      .mockResolvedValue([{ tour: "owner", step: OWNER_DONE, status: "done", updatedAt: "2026-09-26T23:05:24Z" }]);
    mount();
    await flush();
    expect(current()).toBe("none");
    await flush(TOUR_LOAD_RETRY_MS[0] + TOUR_LOAD_RETRY_MS[1] + 10);
    expect(listTours).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("saved").textContent).toBe(`done:${OWNER_DONE}`);
    expect(current()).toBe("none");
  });

  it("asks again after a failed load and respects what the server says: never seen", async () => {
    listTours.mockRejectedValueOnce(new Error("HTTP 502")).mockResolvedValue([]);
    mount();
    await flush();
    expect(current()).toBe("none");
    await flush(TOUR_LOAD_RETRY_MS[0] + 10);
    expect(current()).toBe("owner:0");
    expect(saveTour).toHaveBeenCalledWith("owner", 0, "active");
  });

  it("trusts a save that never reached the server, and hands it over", async () => {
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ owner: { step: 3, status: "later" } }));
    listTours.mockResolvedValue([]);
    mount();
    await flush();
    expect(current()).toBe("none");
    expect(saveTour).toHaveBeenCalledWith("owner", 3, "later");
  });

  it("skipping is final: «Saltar» saves it and a new page load does not start it", async () => {
    listTours.mockResolvedValue([]);
    const view = mount();
    await flush();
    expect(current()).toBe("owner:0");
    fireEvent.click(screen.getByRole("button", { name: "Saltar" }));
    expect(saveTour).toHaveBeenLastCalledWith("owner", 0, "later");
    expect(current()).toBe("none");
    view.unmount();

    // The next deploy reloads the page; the server has the row now.
    listTours.mockResolvedValue([{ tour: "owner", step: 0, status: "later", updatedAt: "2026-09-26T23:10:00Z" }]);
    saveTour.mockClear();
    mount();
    await flush();
    expect(current()).toBe("none");
    expect(saveTour).not.toHaveBeenCalled();
  });
});
