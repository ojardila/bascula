/**
 * «Conexiones» in Configuración: one big button to connect the farm to
 * ChatGPT, «Conectado ✓» once an MCP client holds a grant, and a revocation
 * that goes to the server.
 */
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { CHATGPT_PLUGINS_URL, ConnectionsCard, farmMcpUrl, guideText, isPhone } from "./ConnectionsCard";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";

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

function asDevice(ua: string, touchPoints = 0) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  // jsdom has no maxTouchPoints to spy on; define it.
  Object.defineProperty(navigator, "maxTouchPoints", { value: touchPoints, configurable: true });
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
  vi.restoreAllMocks();
});

describe("the farm MCP address", () => {
  it("is the host the owner is on, plus /mcp", () => {
    expect(farmMcpUrl("https://cafin3.bascula.engp.io")).toBe("https://cafin3.bascula.engp.io/mcp");
    expect(farmMcpUrl("https://bascula.engp.io/")).toBe("https://bascula.engp.io/mcp");
  });

  it("goes into the steps an owner sends to himself", () => {
    const text = guideText("https://san-jose.bascula.engp.io/mcp");
    expect(text).toContain("https://san-jose.bascula.engp.io/mcp");
    expect(text).toContain(CHATGPT_PLUGINS_URL);
    expect(text).toMatch(/Modo desarrollador/);
  });
});

describe("which devices count as a phone", () => {
  it("iPhone, Android phone and iPad are; a Mac is not", () => {
    asDevice(IPHONE_UA);
    expect(isPhone()).toBe(true);
    vi.restoreAllMocks();
    asDevice(ANDROID_UA);
    expect(isPhone()).toBe(true);
    vi.restoreAllMocks();
    asDevice(MAC_UA, 5); // iPadOS claims to be a Mac, with touch
    expect(isPhone()).toBe(true);
    vi.restoreAllMocks();
    asDevice(MAC_UA, 0);
    expect(isPhone()).toBe(false);
  });
});

describe("Conectar con ChatGPT on a computer", () => {
  beforeEach(() => asDevice(MAC_UA));

  it("is a real link to ChatGPT's Plugins page, opened by the tap itself", async () => {
    renderCard();
    const link = await screen.findByRole("link", { name: /Conectar con ChatGPT/ });
    expect(link).toHaveAttribute("href", CHATGPT_PLUGINS_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText(/Crea una conexión segura solo para esta finca/)).toBeInTheDocument();
    // No address to copy in the main path.
    expect(screen.queryByText(/\/mcp$/)).not.toBeInTheDocument();
  });

  it("shows the guide right away, without scripting any window", async () => {
    const open = vi.spyOn(window, "open");
    renderCard();
    fireEvent.click(await screen.findByRole("link", { name: /Conectar con ChatGPT/ }));
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText("Termine en ChatGPT")).toBeInTheDocument();
    expect(screen.getByText(/Seguridad e inicio de sesión/)).toBeInTheDocument();
    expect(screen.getByLabelText("Dirección de la finca para ChatGPT")).toHaveTextContent(/\/mcp$/);
    expect(screen.getByRole("link", { name: /Abrir ChatGPT otra vez/ })).toHaveAttribute("href", CHATGPT_PLUGINS_URL);
  });
});

describe("Conectar con ChatGPT on a phone", () => {
  beforeEach(() => asDevice(IPHONE_UA, 5));

  it("stays in Báscula and says plainly to do it once from a computer", async () => {
    const open = vi.spyOn(window, "open");
    renderCard();
    const btn = await screen.findByRole("button", { name: "Conectar con ChatGPT" });
    fireEvent.click(btn);
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText("Hágalo desde un computador")).toBeInTheDocument();
    expect(screen.getByText(/funciona también/)).toBeInTheDocument();
    expect(screen.getByLabelText("Dirección de la finca para ChatGPT")).toHaveTextContent(/\/mcp$/);
  });

  it("sends the steps to himself through the share sheet", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    try {
      renderCard();
      fireEvent.click(await screen.findByRole("button", { name: "Conectar con ChatGPT" }));
      fireEvent.click(screen.getByRole("button", { name: "Enviarme estos pasos" }));
      await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
      expect(share.mock.calls[0][0].text).toContain("/mcp");
      expect(await screen.findByRole("button", { name: "Enviado" })).toBeInTheDocument();
    } finally {
      delete (navigator as { share?: unknown }).share;
    }
  });
});

describe("Conectado ✓", () => {
  it("shows the state, and Administrar opens the panel that revokes on the server", async () => {
    asDevice(MAC_UA);
    grant();
    renderCard();
    expect(await screen.findByText(/Conectado ✓/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Conectar con ChatGPT/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Administrar" }));
    expect(await screen.findByLabelText("Dirección MCP de la finca")).toHaveTextContent(/\/mcp$/);
    expect(screen.getByText("Activa")).toBeInTheDocument();
    expect(screen.getByText(/Creada el/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revocar conexión" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("¿Revocar la conexión?");
    fireEvent.click(screen.getAllByRole("button", { name: "Revocar conexión" }).at(-1)!);

    await waitFor(() => expect(screen.getByRole("link", { name: /Conectar con ChatGPT/ })).toBeInTheDocument());
    expect(screen.getByText(/Conexión revocada/)).toBeInTheDocument();
    expect(db.tenantOf(db.FARM_ID)!.mcpConnections?.[OWNER]).toHaveLength(0);
  });
});
