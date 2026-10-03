// SPDX-License-Identifier: MIT
/**
 * «Sesiones abiertas» when things go wrong: the list will not load, closing
 * fails, the person backs out of a confirmation, and a farm whose time zone
 * the browser does not know.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/node";
import { renderWithAuth, signInOwner } from "../../test/renderWithAuth";
import { SessionsCard, lastUsedLabel } from "./SessionsCard";

// Long user flows; the coverage run on a loaded machine is slow.
vi.setConfig({ testTimeout: 30_000 });

const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const now = new Date().toISOString();
const SESSIONS = [
  { id: "s1", method: "password", userAgent: WINDOWS, createdAt: now, lastUsedAt: now, current: true },
  { id: "s2", method: "passkey", userAgent: ANDROID, createdAt: now, lastUsedAt: now, current: false },
  { id: "s3", method: "unknown", userAgent: IPAD, createdAt: now, lastUsedAt: now, current: false },
];

function withSessions() {
  server.use(http.get("*/v1/me/sessions", () => HttpResponse.json({ items: SESSIONS })));
}

const boom = () =>
  HttpResponse.json({ error: { code: "INTERNAL", message: "x" } }, { status: 500 });

function renderCard() {
  signInOwner();
  return renderWithAuth(<SessionsCard />);
}

describe("SessionsCard — failures", () => {
  it("says so when the list cannot be loaded", async () => {
    server.use(http.get("*/v1/me/sessions", boom));
    renderCard();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Su cuenta solo está abierta aquí.")).not.toBeInTheDocument();
  });

  it("keeps the session and says why when closing one fails", async () => {
    const user = userEvent.setup();
    withSessions();
    server.use(http.delete("*/v1/me/sessions/:id", boom));
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Cerrar la sesión de Chrome en Android" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cerrar sesión" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Listo. Esa sesión quedó cerrada.")).not.toBeInTheDocument();
    expect(screen.getByText("Chrome en Android")).toBeInTheDocument();
  });

  it("says why when closing the others fails", async () => {
    const user = userEvent.setup();
    withSessions();
    server.use(http.post("*/v1/me/sessions/close-others", boom));
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Cerrar todas las demás sesiones" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cerrar las demás" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/^Listo\./)).not.toBeInTheDocument();
  });
});

describe("SessionsCard — confirmations", () => {
  it("counts one closed session in the singular", async () => {
    const user = userEvent.setup();
    withSessions();
    server.use(
      http.post("*/v1/me/sessions/close-others", () => HttpResponse.json({ closed: 1 })),
    );
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Cerrar todas las demás sesiones" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cerrar las demás" }),
    );
    expect(await screen.findByText("Listo. Se cerró 1 sesión.")).toBeInTheDocument();
  });

  it("closes nothing when the person backs out", async () => {
    const user = userEvent.setup();
    withSessions();
    let deletes = 0;
    let closeOthers = 0;
    server.use(
      http.delete("*/v1/me/sessions/:id", () => {
        deletes += 1;
        return new HttpResponse(null, { status: 204 });
      }),
      http.post("*/v1/me/sessions/close-others", () => {
        closeOthers += 1;
        return HttpResponse.json({ closed: 2 });
      }),
    );
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Cerrar la sesión de Safari en iPad" }));
    let dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("En Safari en iPad tendrá que entrar otra vez con su clave.");
    const confirm = within(dialog).getByRole("button", { name: "Cerrar sesión" });
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    // A late tap on the dialog while it fades out closes nothing.
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Cerrar todas las demás sesiones" }));
    dialog = await screen.findByRole("dialog", { name: "¿Cerrar las demás sesiones?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));

    expect(deletes).toBe(0);
    expect(closeOthers).toBe(0);
    expect(screen.getByText("Abierta el " + new Date(now).toLocaleDateString("es-CO", { dateStyle: "long", timeZone: "America/Bogota" }))).toBeInTheDocument();
  });
});

describe("lastUsedLabel with a time zone the browser does not know", () => {
  it("falls back to the device's own calendar", () => {
    const at = new Date(2026, 8, 25, 12, 0, 0);
    expect(lastUsedLabel(at.toISOString(), "Marte/Base", at)).toBe("hoy");
    const dayBefore = new Date(at.getTime() - 86_400_000);
    expect(lastUsedLabel(dayBefore.toISOString(), "Marte/Base", at)).toBe("ayer");
    const long = new Date(2026, 0, 2, 12, 0, 0);
    expect(lastUsedLabel(long.toISOString(), "Marte/Base", at)).toBe(
      `el ${long.toLocaleDateString("es-CO")}`,
    );
  });
});
