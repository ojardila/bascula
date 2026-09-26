/**
 * «Conexiones» in Configuración: one big button to connect the farm to
 * ChatGPT, «Conectado ✓» once an MCP client holds a grant, and a revocation
 * that goes to the server.
 */
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { CHATGPT_CONNECTORS_URL, CONNECTING_MS, ConnectionsCard, farmMcpUrl } from "./ConnectionsCard";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

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

function grant() {
  const t = db.tenantOf(db.FARM_ID)!;
  const now = new Date();
  t.mcpConnections = {
    [OWNER]: [{
      id: "0192f3a0-00cc-7000-8000-000000000001",
      clientName: "ChatGPT",
      createdAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 86400_000).toISOString(),
    }],
  };
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the farm MCP address", () => {
  it("is the host the owner is on, plus /mcp", () => {
    expect(farmMcpUrl("https://cafin3.bascula.engp.io")).toBe("https://cafin3.bascula.engp.io/mcp");
    expect(farmMcpUrl("https://bascula.engp.io/")).toBe("https://bascula.engp.io/mcp");
  });
});

describe("Conectar con ChatGPT", () => {
  it("shows the big button and the note when nothing is connected", async () => {
    renderCard();
    expect(await screen.findByRole("button", { name: "Conectar con ChatGPT" })).toBeInTheDocument();
    expect(screen.getByText(/Crea una conexión segura solo para esta finca/)).toBeInTheDocument();
    // No address to copy in the main path.
    expect(screen.queryByText(/\/mcp$/)).not.toBeInTheDocument();
  });

  it("says Conectando… and then opens ChatGPT's connector settings", async () => {
    const tab = { document: { title: "", body: { innerHTML: "" } }, location: { href: "" }, closed: false, opener: {} };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    renderCard();
    const btn = await screen.findByRole("button", { name: "Conectar con ChatGPT" });
    vi.useFakeTimers();
    fireEvent.click(btn);
    // The tab is opened inside the tap, so no pop-up blocker stops it.
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Conectando…/ })).toBeDisabled();
    expect(tab.location.href).toBe("");
    await act(async () => {
      vi.advanceTimersByTime(CONNECTING_MS);
    });
    vi.useRealTimers();
    expect(tab.location.href).toBe(CHATGPT_CONNECTORS_URL);
    expect(tab.opener).toBeNull();
    expect(screen.getByText("Termine en ChatGPT")).toBeInTheDocument();
    expect(screen.getByLabelText("Dirección de la finca para ChatGPT")).toHaveTextContent(/\/mcp$/);
  });
});

describe("Conectado ✓", () => {
  it("shows the state, and Administrar opens the panel that revokes on the server", async () => {
    grant();
    renderCard();
    expect(await screen.findByText(/Conectado ✓/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Conectar con ChatGPT" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Administrar" }));
    expect(await screen.findByLabelText("Dirección MCP de la finca")).toHaveTextContent(/\/mcp$/);
    expect(screen.getByText("Activa")).toBeInTheDocument();
    expect(screen.getByText(/Creada el/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revocar conexión" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("¿Revocar la conexión?");
    fireEvent.click(screen.getAllByRole("button", { name: "Revocar conexión" }).at(-1)!);

    await waitFor(() => expect(screen.getByRole("button", { name: "Conectar con ChatGPT" })).toBeInTheDocument());
    expect(screen.getByText(/Conexión revocada/)).toBeInTheDocument();
    expect(db.tenantOf(db.FARM_ID)!.mcpConnections?.[OWNER]).toHaveLength(0);
  });
});
