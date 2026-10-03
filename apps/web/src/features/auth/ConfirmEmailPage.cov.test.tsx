// SPDX-License-Identifier: MIT
/**
 * The «confirmar correo» link: a `token=` fragment, an empty password, a
 * confirmation with no farm address to wait for, a spent link, and a server
 * that cannot be reached.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/node";
import { ConfirmEmailPage } from "./ConfirmEmailPage";

vi.setConfig({ testTimeout: 30_000 });

function renderAt(hash: string) {
  window.history.replaceState(null, "", `/confirmar-correo${hash}`);
  return render(
    <MemoryRouter initialEntries={["/confirmar-correo"]}>
      <Routes>
        <Route path="/confirmar-correo" element={<ConfirmEmailPage />} />
        <Route path="/preparando/:slug" element={<p>esperando finca</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function confirmWith(password: string) {
  const user = userEvent.setup();
  if (password) await user.type(screen.getByLabelText(/Su clave/), password);
  await user.click(screen.getByRole("button", { name: "Confirmar correo" }));
}

describe("ConfirmEmailPage — edges", () => {
  it("reads a token= fragment, wipes it, and confirms without a farm to wait for", async () => {
    let sent: unknown = null;
    server.use(
      http.post("*/v1/auth/verify-email", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ userId: "u", farmId: "f", verified: true });
      }),
    );
    renderAt("#token=secreto-9");
    expect(window.location.hash).toBe("");
    await confirmWith("clave-larga-1");
    expect(await screen.findByText("Listo, su correo quedó confirmado.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/entrar");
    expect(sent).toEqual({ token: "secreto-9", password: "clave-larga-1" });
  });

  it("asks for the password before sending anything", async () => {
    const calls = vi.fn();
    server.use(
      http.post("*/v1/auth/verify-email", () => {
        calls();
        return HttpResponse.json({});
      }),
    );
    renderAt("#secreto-1");
    await confirmWith("");
    expect(
      await screen.findByText("Escriba la clave que eligió al registrarse."),
    ).toBeInTheDocument();
    expect(calls).not.toHaveBeenCalled();
  });

  it("explains a spent link the server refuses", async () => {
    server.use(
      http.post("*/v1/auth/verify-email", () =>
        HttpResponse.json(
          { error: { code: "VALIDATION", message: "this link is no longer valid" } },
          { status: 400 },
        ),
      ),
    );
    renderAt("#secreto-2");
    await confirmWith("clave-larga-1");
    expect(await screen.findByText(/Este enlace ya no sirve/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ir a entrar" })).toBeInTheDocument();
  });

  it("keeps the form and says why when the server cannot be reached", async () => {
    server.use(http.post("*/v1/auth/verify-email", () => HttpResponse.error()));
    renderAt("#secreto-3");
    await confirmWith("clave-larga-1");
    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent(/no es la clave/);
    expect(screen.getByRole("button", { name: "Confirmar correo" })).toBeEnabled();
  });
});
