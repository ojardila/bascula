/**
 * «Sesiones abiertas»: the person's sign-ins on this farm, the current one
 * marked, and closing one or every other through the server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { SessionsCard, lastUsedLabel } from "./SessionsCard";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const HERE = "0192f3a0-00dd-7000-8000-000000000001";
const PHONE = "0192f3a0-00dd-7000-8000-000000000002";
const TABLET = "0192f3a0-00dd-7000-8000-000000000003";

const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function seed(familyId: string, ua: string, method?: "password" | "passkey") {
  db.refreshTokens.push({
    token: `mock-refresh.${familyId}`,
    familyId,
    userId: OWNER,
    farmId: db.FARM_ID,
    expiresAt: Date.now() + 86_400_000,
    rotatedAt: null,
    revokedAt: null,
    issuedAt: Date.now() - 60_000,
    method,
    userAgent: ua,
  });
}

function renderCard() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <SessionsCard />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  seed(HERE, WINDOWS, "password");
  seed(PHONE, ANDROID, "passkey");
  seed(TABLET, IPAD);
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}.${HERE}`,
    refreshToken: `mock-refresh.${HERE}`,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Sesiones abiertas", () => {
  it("lists each device, how it got in, and marks this one", async () => {
    renderCard();
    expect(await screen.findByText("Chrome en Windows")).toBeInTheDocument();
    expect(screen.getByText("Este dispositivo")).toBeInTheDocument();
    expect(screen.getByText("Chrome en Android")).toBeInTheDocument();
    expect(screen.getByText("Safari en iPad")).toBeInTheDocument();
    expect(
      screen.getByText(/^Entró con llave de acceso el/),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Entró con la clave el/)).toBeInTheDocument();
    expect(screen.getByText(/^Abierta el/)).toBeInTheDocument();
    expect(screen.getAllByText("Último uso: hoy")).toHaveLength(3);
    // This device has no «Cerrar»; the two others do.
    expect(
      screen.getAllByRole("button", { name: /^Cerrar la sesión de/ }),
    ).toHaveLength(2);
  });

  it("closes one session after confirming", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(
      await screen.findByRole("button", {
        name: "Cerrar la sesión de Chrome en Android",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Chrome en Android tendrá que entrar otra vez/),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Cerrar sesión" }),
    );

    expect(
      await screen.findByText("Listo. Esa sesión quedó cerrada."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Chrome en Android")).not.toBeInTheDocument(),
    );
    expect(
      db.refreshTokens.find((t) => t.familyId === PHONE)?.revokedAt,
    ).not.toBeNull();
    expect(
      db.refreshTokens.find((t) => t.familyId === HERE)?.revokedAt,
    ).toBeNull();
  });

  it("closes every other session and keeps this one", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(
      await screen.findByRole("button", {
        name: "Cerrar todas las demás sesiones",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Cerrar las demás" }),
    );

    expect(
      await screen.findByText("Listo. Se cerraron 2 sesiones."),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Su cuenta solo está abierta aquí."),
    ).toBeInTheDocument();
    expect(screen.getByText("Chrome en Windows")).toBeInTheDocument();
    expect(
      db.refreshTokens.find((t) => t.familyId === HERE)?.revokedAt,
    ).toBeNull();
  });

  it("does not offer «todas» when only one other session is open", async () => {
    db.refreshTokens.find((t) => t.familyId === TABLET)!.revokedAt = Date.now();
    renderCard();
    expect(await screen.findByText("Chrome en Android")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cerrar todas las demás sesiones" }),
    ).not.toBeInTheDocument();
  });
});

describe("lastUsedLabel", () => {
  const now = new Date("2026-10-02T20:00:00-05:00");
  it("says hoy, ayer, or the date", () => {
    expect(
      lastUsedLabel("2026-10-02T08:00:00-05:00", "America/Bogota", now),
    ).toBe("hoy");
    expect(
      lastUsedLabel("2026-10-01T08:00:00-05:00", "America/Bogota", now),
    ).toBe("ayer");
    expect(
      lastUsedLabel("2026-09-20T08:00:00-05:00", "America/Bogota", now),
    ).toMatch(/^el 20 de septiembre de 2026$/);
  });
});
