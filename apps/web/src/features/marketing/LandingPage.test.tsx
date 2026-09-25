import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

async function fillDemoForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("textbox", { name: "Nombre" }), "Ana Rodríguez");
  await user.type(screen.getByRole("textbox", { name: "Teléfono de contacto" }), "+57 300 123 4567");
  await user.type(screen.getByRole("textbox", { name: "Correo electrónico" }), "ana@correo.com");
  await user.type(screen.getByRole("textbox", { name: "Nombre de la finca" }), "La Esperanza");
}

beforeEach(() => {
  setTokens(null);
  invalidateRefs();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the public landing", () => {
  it("says what it does and for whom, with one demo action", async () => {
    renderApp("/");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Registre los kilos de café y calcule cuánto debe a cada recolector.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Para fincas cafeteras/i)).toBeInTheDocument();
    // Every "Solicitar una demostración" link goes to the single form.
    const demoLinks = screen.getAllByRole("link", { name: "Solicitar una demostración" });
    expect(demoLinks.length).toBeGreaterThanOrEqual(3);
    for (const link of demoLinks) expect(link).toHaveAttribute("href", "#demo");
    expect(screen.getByRole("link", { name: "Ver cómo funciona" })).toHaveAttribute("href", "#como-funciona");
    expect(document.querySelectorAll("form")).toHaveLength(1);
  });

  it("has the sections the navigation points to", async () => {
    renderApp("/");
    const nav = await screen.findByRole("navigation", { name: "Secciones" });
    for (const [name, id] of [
      ["Cómo funciona", "como-funciona"],
      ["Qué puede consultar", "que-puede-consultar"],
      ["Preguntas frecuentes", "preguntas-frecuentes"],
    ]) {
      expect(within(nav).getByRole("link", { name })).toHaveAttribute("href", `#${id}`);
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(screen.getByRole("heading", { name: "Así pasa una pesada a la cuenta del recolector." })).toBeInTheDocument();
    expect(screen.getByText("EJEMPLO ILUSTRATIVO · VALORES EN PESOS COLOMBIANOS")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "¿Cuánto cuesta?" })).toBeInTheDocument();
  });

  it("says it is a web app: nothing to install, weighings without signal", async () => {
    renderApp("/");
    expect(await screen.findByText(/No hay nada que instalar/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Nada que instalar" })).toBeInTheDocument();
    expect(screen.getAllByText(/agréguela a la pantalla de inicio del celular/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/registrar kilos sin señal/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "¿Tengo que instalar algo?" })).toBeInTheDocument();
    // Real screens of the web app in a browser window: no phone frames.
    const shots = [...document.querySelectorAll("img")].map((i) => i.getAttribute("src") ?? "").filter((src) => src.startsWith("/landing/app/"));
    expect(shots).toEqual(expect.arrayContaining([
      "/landing/app/cosecha.jpg",
      "/landing/app/registrar-pesada.jpg",
      "/landing/app/semana.jpg",
      "/landing/app/nomina.jpg",
      "/landing/app/pagar.jpg",
      "/landing/app/semana-recolectores.jpg",
      "/landing/app/cuenta.jpg",
      "/landing/app/lotes.jpg",
    ]));
    expect(shots.some((src) => /phone|\.png$/.test(src))).toBe(false);
    for (const img of document.querySelectorAll("img[src^='/landing/app/']")) {
      expect(img.getAttribute("alt")).toMatch(/^Báscula .*navegador/);
    }
    expect(screen.getAllByText("Datos de demostración").length).toBeGreaterThanOrEqual(8);
    expect(screen.queryByText(/sincronice/i)).toBeNull();
  });

  it("opens a screenshot full size on a tap, and closes it", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: /^Ampliar: Báscula abierta en el navegador: la cosecha/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("img")).toHaveAttribute("src", "/landing/app/cosecha.jpg");
    await user.click(within(dialog).getByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the free self-serve signup and the sign-in link", async () => {
    renderApp("/");
    const cta = await screen.findByRole("link", { name: "Cree su finca gratis" });
    expect(cta).toHaveAttribute("href", "/empezar");
    expect(screen.getByRole("link", { name: "Crear mi finca" })).toHaveAttribute("href", "/empezar");
    for (const link of screen.getAllByRole("link", { name: "Iniciar sesión" })) {
      expect(link).toHaveAttribute("href", "/entrar");
    }
  });

  it("asks for each missing field by name", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Solicitar una demostración" }));
    expect(screen.getByText("Escriba su nombre.")).toBeInTheDocument();
    expect(screen.getByText("Escriba un número de teléfono donde podamos contactarlo.")).toBeInTheDocument();
    expect(screen.getByText("Revise el correo electrónico. Ejemplo: nombre@correo.com.")).toBeInTheDocument();
    expect(screen.getByText("Escriba el nombre de su finca.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirms only after the request is received", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderApp("/");
    await screen.findByRole("heading", { level: 1 });
    await fillDemoForm(user);
    await user.click(screen.getByRole("button", { name: "Solicitar una demostración" }));
    expect(
      await screen.findByText("Recibimos su solicitud. Nos pondremos en contacto para acordar la demostración."),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not claim success when it falls back to the mail app, and keeps the data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();
    renderApp("/");
    await screen.findByRole("heading", { level: 1 });
    await fillDemoForm(user);
    await user.click(screen.getByRole("button", { name: "Solicitar una demostración" }));
    expect(await screen.findByText("No pudimos enviar su solicitud. Intente de nuevo.")).toBeInTheDocument();
    expect(screen.getByText(/Se abrirá su aplicación de correo/)).toBeInTheDocument();
    expect(screen.queryByText(/Recibimos su solicitud/)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Nombre de la finca" })).toHaveValue("La Esperanza");
  });

  it("lets someone start a farm and pick its web address", async () => {
    renderApp("/empezar");
    expect(await screen.findByRole("heading", { name: "Cree su finca" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Dirección web de la finca/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Precio por kilo/)).toBeNull();
  });
});
