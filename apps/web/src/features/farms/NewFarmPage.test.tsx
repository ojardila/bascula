import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { resetDb } from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

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
  resetDb();
  invalidateRefs();
  localStorage.clear();
  setTokens({ accessToken: `mock-access.${OWNER}.test`, refreshToken: `mock-refresh.${OWNER}` });
});

describe("Crear otra finca, from inside the app", () => {
  it("creates a farm with its own address and shows it being prepared", async () => {
    const user = userEvent.setup();
    renderApp("/fincas/nueva");
    await user.type(await screen.findByLabelText(/Nombre de la finca/), "El Cedral");
    expect((screen.getByLabelText(/Dirección web de la finca/) as HTMLInputElement).value).toBe("el-cedral");
    await user.click(screen.getByRole("button", { name: "Crear finca" }));
    expect(await screen.findByText("Preparando su finca…")).toBeInTheDocument();
    expect(screen.getByText(/el-cedral\.bascula\.engp\.io/)).toBeInTheDocument();
  });
});
