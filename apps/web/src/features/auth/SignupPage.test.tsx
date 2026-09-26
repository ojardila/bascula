import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { resetDb } from "../../mocks/db";
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
  resetDb();
});

describe("Cree su finca — the farm's web address", () => {
  it("fills the address from the farm name, previews it and says it is free", async () => {
    const user = userEvent.setup();
    renderApp("/empezar");
    await user.type(await screen.findByLabelText(/Nombre de la finca/), "La Palma Alta");
    const field = screen.getByLabelText(/Dirección web de la finca/) as HTMLInputElement;
    expect(field.value).toBe("la-palma-alta");
    const preview = screen.getByTestId("farm-url-preview");
    expect(preview).toHaveTextContent(/la-palma-alta\./);
    expect(await within(preview).findByText(/Disponible/)).toBeInTheDocument();
  });

  it("keeps what the owner types inside the rule and explains a bad address", async () => {
    const user = userEvent.setup();
    renderApp("/empezar");
    const field = (await screen.findByLabelText(/Dirección web de la finca/)) as HTMLInputElement;
    await user.type(field, "Finca José");
    expect(field.value).toBe("finca-jose");
    await user.clear(field);
    await user.type(field, "admin");
    expect(await screen.findByText("Esa dirección está reservada. Escriba otra.")).toBeInTheDocument();
  });

  it("says in plain Spanish when another farm already has the address", async () => {
    const user = userEvent.setup();
    renderApp("/empezar");
    const field = await screen.findByLabelText(/Dirección web de la finca/);
    await user.type(field, "la-esperanza");
    expect(
      await screen.findByText("Esa dirección ya la tiene otra finca. Escriba otra."),
    ).toBeInTheDocument();
  });

  it("creates the farm and shows the waiting page for its address", async () => {
    const user = userEvent.setup();
    renderApp("/empezar");
    await user.type(await screen.findByLabelText(/Nombre de la finca/), "Lapalma");
    await user.type(screen.getByLabelText(/Su nombre/), "Oscar");
    await user.type(screen.getByLabelText(/^Correo/), "nuevo-dueno@example.com");
    await user.type(screen.getByLabelText(/^Clave/), "una-clave-larga");
    await user.click(screen.getByRole("button", { name: "Crear mi finca" }));
    expect(await screen.findByText("Preparando su finca…", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText(/lapalma\.bascula\.engp\.io/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("step-database")).toBeInTheDocument());
    expect(screen.getByText(/Puede tardar unos minutos/)).toBeInTheDocument();
  });

  it("creates the farm even when the email already owns another farm", async () => {
    // One email may own several farms: no «ese correo ya tiene cuenta».
    const user = userEvent.setup();
    renderApp("/empezar");
    await user.type(await screen.findByLabelText(/Nombre de la finca/), "Segunda Finca");
    await user.type(screen.getByLabelText(/Su nombre/), "Oscar");
    await user.type(screen.getByLabelText(/^Correo/), "oscar@laesperanza.co");
    await user.type(screen.getByLabelText(/^Clave/), "otra-clave-para-esta-finca");
    await user.click(screen.getByRole("button", { name: "Crear mi finca" }));
    expect(await screen.findByText("Preparando su finca…", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText(/segunda-finca\.bascula\.engp\.io/)).toBeInTheDocument();
    expect(screen.queryByText("Ese correo ya tiene cuenta")).not.toBeInTheDocument();
  });
});
