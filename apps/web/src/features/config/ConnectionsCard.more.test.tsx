/**
 * The less travelled corners of «Conexiones»: an expired, read-only grant
 * managed while not connected, a revocation the server refuses, copying the
 * address, and asking again when the owner comes back to the app.
 */
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { ConnectionsCard } from "./ConnectionsCard";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";

function renderCard() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <ConnectionsCard />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function grant(opts: { expired?: boolean; access?: "read" | "write" } = {}) {
  const now = Date.now();
  db.tenantOf(db.FARM_ID)!.mcpConnections = {
    [OWNER]: [
      {
        id: "0192f3a0-00cc-7000-8000-000000000002",
        clientName: "Claude",
        createdAt: new Date(now - 90 * 86400_000).toISOString(),
        lastUsedAt: new Date(now - 60 * 86400_000).toISOString(),
        expiresAt: new Date(
          now + (opts.expired ? -1 : 60) * 86400_000,
        ).toISOString(),
        access: opts.access,
      },
    ],
  };
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openManage() {
  fireEvent.click(await screen.findByRole("button", { name: "Administrar" }));
  return screen.findByText("Claude");
}

describe("an expired grant, while not connected", () => {
  it("is still listed under Administrar, marked expired and read-only", async () => {
    grant({ expired: true, access: "read" });
    renderCard();
    // Not connected: the button to connect is still there.
    expect(
      await screen.findByRole("link", { name: /Conectar con ChatGPT/ }),
    ).toBeInTheDocument();
    await openManage();
    expect(screen.getByText("Vencida")).toBeInTheDocument();
    expect(
      screen.getByText("Solo consulta: no puede registrar nada."),
    ).toBeInTheDocument();
  });

  it("can be kept: cancelling the confirmation revokes nothing", async () => {
    grant({ expired: true });
    renderCard();
    await openManage();
    fireEvent.click(screen.getByRole("button", { name: "Revocar conexión" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/Claude dejará de tener acceso/);
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancelar/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(db.tenantOf(db.FARM_ID)!.mcpConnections?.[OWNER]).toHaveLength(1);
  });

  it("says why when the server refuses the revocation, and the note can be closed", async () => {
    grant({ expired: true });
    const refusal = new ApiError(409, {
      error: { code: "CONFLICT", message: "connection changed" },
    });
    const said = messageFor(refusal);
    vi.spyOn(api, "revokeMcpConnection").mockRejectedValue(refusal);
    renderCard();
    await openManage();
    fireEvent.click(screen.getByRole("button", { name: "Revocar conexión" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Revocar conexión" }),
    );
    const alert = await screen.findByText(said);
    expect(screen.queryByText(/Conexión revocada/)).not.toBeInTheDocument();
    expect(db.tenantOf(db.FARM_ID)!.mcpConnections?.[OWNER]).toHaveLength(1);
    // The confirmation stays open so the owner can try again or give up.
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancelar/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    fireEvent.click(
      within(alert.closest('[role="alert"]') as HTMLElement).getByRole(
        "button",
        { name: /close|cerrar/i },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText(said)).not.toBeInTheDocument(),
    );
  });

  it("once revoked, the confirmation can be dismissed", async () => {
    grant({ expired: true });
    renderCard();
    await openManage();
    fireEvent.click(screen.getByRole("button", { name: "Revocar conexión" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Revocar conexión" }),
    );
    const done = await screen.findByText(/Conexión revocada/);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(
      within(done.closest('[role="alert"]') as HTMLElement).getByRole(
        "button",
        { name: /close|cerrar/i },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText(/Conexión revocada/)).not.toBeInTheDocument(),
    );
  });
});

describe("the creation date", () => {
  it("still shows when the farm's timezone is one the browser does not know", async () => {
    db.farmOf(db.FARM_ID)!.timezone = "Marte/Olimpo";
    grant({ expired: true });
    renderCard();
    await openManage();
    expect(screen.getByText(/Creada el .*\d/)).toBeInTheDocument();
  });
});

describe("copying the MCP address", () => {
  it("says Copiada once the clipboard took it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    grant();
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Administrar" }));
    await screen.findByLabelText("Dirección MCP de la finca");
    fireEvent.click(screen.getAllByRole("button", { name: "Copiar" })[0]);
    expect(
      await screen.findByRole("button", { name: "Copiada" }),
    ).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/mcp$/));
  });

  it("keeps saying Copiar when the browser refuses the clipboard", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    grant();
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Administrar" }));
    await screen.findByLabelText("Dirección MCP de la finca");
    fireEvent.click(screen.getAllByRole("button", { name: "Copiar" })[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: "Copiada" }),
    ).not.toBeInTheDocument();
  });
});

describe("coming back to the app", () => {
  it("asks again when the page is visible, and not while it is hidden", async () => {
    const list = vi.spyOn(api, "listMcpConnections");
    renderCard();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(list).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});
