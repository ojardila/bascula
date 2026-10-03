// SPDX-License-Identifier: MIT
/**
 * `useHarvestMode`: the head start kept in this browser, and the farm record
 * failing — or arriving after the screen has gone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { AuthProvider, useAuth } from "../../auth/AuthContext";
import { server } from "../../mocks/node";
import { FARM_ID, farms } from "../../mocks/db";
import { signInOwner } from "../../test/renderWithAuth";
import { useHarvestMode } from "./harvestMode";

const CACHE = `bascula.harvestMode.${FARM_ID}`;

/** Mounts the hook only once the user (and so the farm) is known, as the app does. */
function Ready({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user ? <>{children}</> : null;
}
const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    <AuthProvider>
      <Ready>{children}</Ready>
    </AuthProvider>
  </MemoryRouter>
);

const failing = () =>
  HttpResponse.json({ error: { code: "internal", message: "boom" } }, { status: 500 });

/** A GET /v1/farm held until `release` is called. */
function holdFarm(answer: () => Response) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let asked = 0;
  server.use(
    http.get("*/v1/farm", async () => {
      asked++;
      await gate;
      return answer();
    }),
  );
  return { release, asked: () => asked };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("useHarvestMode", () => {
  it("keeps the cached «on» when the farm record cannot be read", async () => {
    signInOwner();
    localStorage.setItem(CACHE, "1");
    server.use(http.get("*/v1/farm", failing));
    const { result } = renderHook(() => useHarvestMode(), { wrapper });
    await waitFor(() => expect(result.current?.on).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.on).toBe(true);
  });

  it("starts from a cached «off» and settles on the server's answer", async () => {
    signInOwner();
    localStorage.setItem(CACHE, "0");
    const farm = holdFarm(() => HttpResponse.json({}, { status: 500 }));
    const { result } = renderHook(() => useHarvestMode(), { wrapper });
    await waitFor(() => expect(result.current?.on).toBe(false));
    expect(farm.asked()).toBeGreaterThan(0);
    farm.release();
  });

  it("reads an unknown cached value, or a refusing storage, as unknown and then «off»", async () => {
    signInOwner();
    localStorage.setItem(CACHE, "quizás");
    const farm = holdFarm(failing);
    const first = renderHook(() => useHarvestMode(), { wrapper });
    await waitFor(() => expect(farm.asked()).toBeGreaterThan(0));
    expect(first.result.current.on).toBeNull();
    farm.release();
    await waitFor(() => expect(first.result.current.on).toBe(false));
    first.unmount();

    signInOwner();
    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, k: string) {
      if (k === CACHE) throw new Error("blocked");
      return getItem.call(this, k);
    });
    const blocked = holdFarm(failing);
    const second = renderHook(() => useHarvestMode(), { wrapper });
    await waitFor(() => expect(blocked.asked()).toBeGreaterThan(0));
    expect(second.result.current.on).toBeNull();
    blocked.release();
    await waitFor(() => expect(second.result.current.on).toBe(false));
  });

  it("ignores a farm record that arrives, or fails, after unmounting", async () => {
    for (const answer of [() => HttpResponse.json({ ...farms.find((f) => f.id === FARM_ID)!, harvestMode: true }), failing]) {
      signInOwner();
      const farm = holdFarm(answer);
      const { result, unmount } = renderHook(() => useHarvestMode(), { wrapper });
      await waitFor(() => expect(farm.asked()).toBeGreaterThan(0));
      expect(result.current.on).toBeNull();
      unmount();
      farm.release();
      await new Promise((r) => setTimeout(r, 50));
      expect(result.current.on).toBeNull();
    }
  });
});
