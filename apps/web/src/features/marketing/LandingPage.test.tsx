import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";

function renderApp(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
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

describe("the public landing", () => {
  it("offers to create a farm without asking for a password first", async () => {
    renderApp("/");
    expect(
      await screen.findByRole("heading", {
        name: /La báscula de su finca, en el bolsillo y en la oficina/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Crear mi finca" })).toHaveAttribute("href", "/empezar");
  });

  it("lets someone start a farm and pick the URL slug", async () => {
    renderApp("/empezar");
    expect(await screen.findByRole("heading", { name: "Crear mi finca" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Identificador/)).toBeInTheDocument();
  });
});
