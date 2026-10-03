// SPDX-License-Identifier: MIT
/** The passkey offer after a password: a server failure is shown as it is. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { PasskeyOffer } from "./PasskeyOffer";
import { server } from "../../mocks/node";
import { theme } from "../../theme";
import { signInOwner } from "../../test/renderWithAuth";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PasskeyOffer", () => {
  it("shows the server's refusal and still lets the person continue", async () => {
    signInOwner();
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    server.use(
      http.post("*/v1/me/passkeys/options", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom", details: {} } },
          { status: 500 },
        ),
      ),
    );
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(
      <ThemeProvider theme={theme}>
        <PasskeyOffer password="esperanza" onDone={onDone} />
      </ThemeProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Sí, activarlo/ }));
    expect(await screen.findByText("No se pudo activar")).toBeInTheDocument();
    expect(
      screen.getByText("El servidor tuvo un problema. Intente de nuevo en un momento."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(onDone).toHaveBeenCalled();
  });
});
