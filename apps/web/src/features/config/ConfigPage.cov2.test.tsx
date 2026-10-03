// SPDX-License-Identifier: MIT
/**
 * Configuración: the status note while /v1/farm has not answered yet, the
 * release the server reports.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse, delay } from "msw";
import { ConfigPage } from "./ConfigPage";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { signInOwner } from "../../test/renderWithAuth";

vi.setConfig({ testTimeout: 30_000 });

function renderConfig() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/configuracion"]}>
        <AuthProvider>
          <ConfigPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  invalidateRefs();
});

describe("ConfigPage", () => {
  it("says it is still asking while the farm's status has not arrived", async () => {
    signInOwner();
    server.use(
      http.get("*/v1/farm", async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    renderConfig();
    expect(await screen.findByTitle("Consultando el estado de la finca…")).toHaveTextContent("—");
  });

  it("shows the release the server reports", async () => {
    signInOwner();
    server.use(
      http.get("*/version.json", () => HttpResponse.json({ version: "v9.8.7", build: "abc" })),
    );
    renderConfig();
    expect(await screen.findByText(/Báscula versión v9\.8\.7/)).toBeInTheDocument();
  });
});
