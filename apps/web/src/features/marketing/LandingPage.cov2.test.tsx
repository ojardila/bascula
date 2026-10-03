// SPDX-License-Identifier: MIT
/**
 * The landing for somebody already signed in (a way back to the farm, no
 * signup pitch), the screenshot closed with Escape, a field's error clearing
 * as it is fixed, and a demo request the form service refuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { signInOwner } from "../../test/renderWithAuth";

vi.setConfig({ testTimeout: 30_000 });

function renderLanding() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  setTokens(null);
  invalidateRefs();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LandingPage — signed in", () => {
  it("offers the way back to the farm and drops the signup pitch at the end", async () => {
    signInOwner();
    renderLanding();
    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: "Ir a mi finca" })).toHaveLength(2),
    );
    const closing = document.getElementById("demo")!;
    expect(within(closing).queryByRole("link", { name: "Cree su finca gratis" })).toBeNull();
  });
});

describe("LandingPage — screenshot and form", () => {
  it("closes an enlarged screenshot with Escape", async () => {
    const user = userEvent.setup();
    renderLanding();
    await user.click(
      await screen.findByRole("button", { name: /^Ampliar: Báscula abierta en el navegador: la cosecha/ }),
    );
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("clears a field's error as soon as it is typed in", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    renderLanding();
    await user.click(await screen.findByRole("button", { name: "Solicitar una demostración" }));
    expect(screen.getByText("Escriba su nombre.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Nombre" }), "A");
    expect(screen.queryByText("Escriba su nombre.")).toBeNull();
    // The other errors stay until their own field is fixed.
    expect(screen.getByText("Escriba el nombre de su finca.")).toBeInTheDocument();
  });

  it("does not claim success when the form service answers with an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));
    const user = userEvent.setup();
    renderLanding();
    await screen.findByRole("heading", { level: 1 });
    await user.type(screen.getByRole("textbox", { name: "Nombre" }), "Ana Rodríguez");
    await user.type(screen.getByRole("textbox", { name: "Teléfono de contacto" }), "310 482 7391");
    await user.type(screen.getByRole("textbox", { name: "Correo electrónico" }), "ana@correo.com");
    await user.type(screen.getByRole("textbox", { name: "Nombre de la finca" }), "La Esperanza");
    await user.click(screen.getByRole("button", { name: "Solicitar una demostración" }));
    expect(await screen.findByText("No pudimos enviar su solicitud. Intente de nuevo.")).toBeInTheDocument();
    expect(screen.queryByText(/Recibimos su solicitud/)).toBeNull();
  });
});
