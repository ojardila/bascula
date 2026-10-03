// SPDX-License-Identifier: MIT
/**
 * AuthProvider at the edges: opening offline with nobody remembered, a
 * remembered user from an older build with no farm on it, unmounting before
 * /v1/me answers, and useAuth used outside the provider.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse, delay } from "msw";
import { server } from "../mocks/node";
import { getTokens, setTokens } from "../api/client";
import { AuthProvider, useAuth } from "./AuthContext";

function Probe() {
  const { status, principal, readOnly } = useAuth();
  return (
    <p>
      {status} · {principal.farmStatus} · {readOnly ? "solo lectura" : "editable"}
    </p>
  );
}

const unavailable = () =>
  http.get("*/v1/me", () =>
    HttpResponse.json({ error: { code: "UNAVAILABLE", message: "down" } }, { status: 503 }),
  );

afterEach(() => {
  setTokens(null);
  localStorage.removeItem("bascula.lastUser");
  vi.restoreAllMocks();
});

describe("AuthProvider", () => {
  it("opens offline with nobody remembered on this device as signed out", async () => {
    setTokens({ accessToken: "a", refreshToken: "r" });
    server.use(unavailable());
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(await screen.findByText(/anonymous/)).toBeInTheDocument();
    expect(getTokens()).toBeNull();
  });

  it("opens offline as signed out when the remembered user is unreadable", async () => {
    setTokens({ accessToken: "a", refreshToken: "r" });
    localStorage.setItem("bascula.lastUser", "{no es json");
    server.use(unavailable());
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(await screen.findByText(/anonymous/)).toBeInTheDocument();
  });

  it("treats a remembered user with no farm on it as an active farm", async () => {
    setTokens({ accessToken: "a", refreshToken: "r" });
    localStorage.setItem(
      "bascula.lastUser",
      JSON.stringify({ id: "u", email: "a@b.co", name: "Ana", role: "owner", isSuperAdmin: false, memberships: [] }),
    );
    server.use(unavailable());
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(await screen.findByText("authenticated · active · editable")).toBeInTheDocument();
  });

  it("ignores a failed /v1/me that lands after it unmounted", async () => {
    setTokens({ accessToken: "a", refreshToken: "r" });
    let answered = false;
    server.use(
      http.get("*/v1/me", async () => {
        await delay(50);
        answered = true;
        return HttpResponse.json({ error: { code: "UNAUTHORIZED", message: "x" } }, { status: 403 });
      }),
    );
    const { unmount } = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    unmount();
    await waitFor(() => expect(answered).toBe(true));
    // The tokens are kept: nobody was left on screen to sign out.
    await new Promise((r) => setTimeout(r, 20));
    expect(getTokens()).not.toBeNull();
  });

  it("useAuth outside the provider is a programming error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useAuth())).toThrow("useAuth fuera de <AuthProvider>");
  });
});
