/**
 * The one network edge: every write runs through `request()`, and every write
 * announces itself on the cross-tab channel. Reads never do — a GET that fires
 * a broadcast would make every tab re-fetch for a tab that merely read, which
 * is the opposite of what live-sync is for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as crossTab from "../lib/crossTab";
import { http, setTokens } from "./client";
import * as db from "../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function signIn(userId: string): void {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
}

describe("http client — mutation broadcast", () => {
  beforeEach(() => {
    db.resetDb();
    signIn(OWNER);
  });

  it("broadcasts after a successful write", async () => {
    const spy = vi.spyOn(crossTab, "broadcastMutation");
    await http.post<unknown>("/v1/workers", {
      name: "Ana",
      lastName: "Rodríguez",
      tag: "99",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("does not broadcast after a read", async () => {
    const spy = vi.spyOn(crossTab, "broadcastMutation");
    await http.get<unknown>("/v1/workers");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not broadcast when the write fails", async () => {
    const spy = vi.spyOn(crossTab, "broadcastMutation");
    // Missing required name — the server rejects it with a 400.
    await http
      .post<unknown>("/v1/workers", { lastName: "sin nombre" })
      .catch(() => undefined);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
