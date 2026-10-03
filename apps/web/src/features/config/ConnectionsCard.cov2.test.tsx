// SPDX-License-Identifier: MIT
/**
 * «Conexiones», the corners the other files leave: what counts as a phone
 * with odd browsers, «Copiada» going back to «Copiar», a reload while a retry
 * is waiting, asking again when the window gets focus during the guide, a
 * computer that turns into a phone after the first render, a second press on
 * «Revocar conexión» while the dialog fades, and the page the weigher gets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { CHECK_RETRY_MS, ConnectionsCard, isPhone } from "./ConnectionsCard";
import { ConnectionsPage } from "./ConnectionsPage";
import { api } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { OWNER, signInOwner } from "../../test/renderWithAuth";

vi.setConfig({ testTimeout: 30_000 });

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";

function asDevice(ua: string, touchPoints = 0) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  Object.defineProperty(navigator, "maxTouchPoints", {
    value: touchPoints,
    configurable: true,
  });
}

function wrap(ui: React.ReactElement) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function grant() {
  const now = Date.now();
  db.tenantOf(db.FARM_ID)!.mcpConnections = {
    [OWNER]: [
      {
        id: "0192f3a0-00cc-7000-8000-000000000003",
        clientName: "Claude",
        createdAt: new Date(now).toISOString(),
        lastUsedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60 * 86400_000).toISOString(),
      },
    ],
  };
}

const network = () => new ApiError(0, { error: { code: "NETWORK", message: "network" } });

beforeEach(() => {
  signInOwner();
  invalidateRefs();
  asDevice(MAC_UA);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("isPhone, with unusual browsers", () => {
  it("is never a phone where there is no navigator at all", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isPhone()).toBe(false);
  });

  it("treats a browser with no user agent like a computer", () => {
    asDevice("");
    expect(isPhone()).toBe(false);
  });

  it("counts an iPad as a phone", () => {
    asDevice(IPAD_UA);
    expect(isPhone()).toBe(true);
  });

  it("counts a small touch-only screen as a phone, and a big one as not", () => {
    let wide = false;
    vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) =>
        ({
          matches: q.includes("coarse") || (q.includes("max-width") && !wide),
          media: q,
        }) as MediaQueryList,
    );
    expect(isPhone()).toBe(true);
    wide = true;
    expect(isPhone()).toBe(false);
  });
});

describe("ConnectionsCard — timers and focus", () => {
  it("goes back to «Copiar» a little after copying", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    grant();
    wrap(<ConnectionsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Administrar" }));
    await screen.findByLabelText("Dirección MCP de la finca");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getAllByRole("button", { name: "Copiar" })[0]);
    expect(await screen.findByRole("button", { name: "Copiada" })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });
    expect(screen.queryByRole("button", { name: "Copiada" })).not.toBeInTheDocument();
  });

  it("drops a waiting retry when the person comes back and it asks again", async () => {
    const real = api.listMcpConnections.bind(api);
    const spy = vi
      .spyOn(api, "listMcpConnections")
      .mockRejectedValueOnce(network())
      .mockImplementation(real);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wrap(<ConnectionsCard />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // The failure schedules a retry; coming back clears it and asks now.
    await act(async () => {
      await Promise.resolve();
    });
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_RETRY_MS[0] + 50);
    });
    // The cleared retry never fires: still two checks.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("asks again when the window gets focus while the guide is open", async () => {
    const spy = vi.spyOn(api, "listMcpConnections");
    wrap(<ConnectionsCard />);
    const link = await screen.findByRole("link", { name: /Conectar con ChatGPT/ });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    fireEvent.click(link);
    expect(screen.getByText("Termine en ChatGPT")).toBeInTheDocument();
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it("stays in Báscula when the device turned out to be a phone after the card was drawn", async () => {
    wrap(<ConnectionsCard />);
    const link = await screen.findByRole("link", { name: /Conectar con ChatGPT/ });
    asDevice(IPHONE_UA, 5);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, click);
    expect(click.defaultPrevented).toBe(true);
    expect(screen.getByText("Termine en ChatGPT")).toBeInTheDocument();
  });
});

describe("ConnectionsCard — revoking twice", () => {
  it("ignores a second press on «Revocar conexión» while the dialog closes", async () => {
    grant();
    const revoke = vi.spyOn(api, "revokeMcpConnection");
    wrap(<ConnectionsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Administrar" }));
    await screen.findByText("Claude");
    fireEvent.click(screen.getByRole("button", { name: "Revocar conexión" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Revocar conexión" });
    fireEvent.click(confirm);
    expect(await screen.findByText(/Conexión revocada/)).toBeInTheDocument();
    fireEvent.click(confirm);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe("ConnectionsPage", () => {
  it("puts «Conexiones» and the account cards on one page", async () => {
    wrap(<ConnectionsPage />);
    expect(screen.getByRole("heading", { name: "Conexiones", level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Cambiar clave" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Conectar con ChatGPT/ })).toBeInTheDocument();
  });
});
