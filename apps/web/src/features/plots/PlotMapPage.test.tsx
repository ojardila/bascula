/**
 * The map screen, driven the way a keyboard user drives it.
 *
 * Nothing here fakes a pointer. jsdom has no layout, so `getBoundingClientRect`
 * answers zeroes and every drag would be a test of our arithmetic against a
 * canvas that is nought pixels wide — green, meaningless, and impossible to
 * make fail for a real reason. The corner table exists so that the same
 * screen is usable without a mouse; driving the tests through it means the
 * accessible path is the one that cannot rot.
 *
 * What is actually being checked is the chain the whole feature rests on:
 * typed coordinates -> a measured area -> a PUT -> the server's own hectares
 * beside the declared ones, and a refusal in Spanish when the ring crosses
 * itself.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { PlotMapPage } from "./PlotMapPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { theme } from "../../theme";
import { resetDb } from "../../mocks/db";

/** "La Cuchilla" in the seed: declared 2,75 ha, no polygon yet. */
const UNDRAWN = "0192f3a0-0004-7000-8000-000000000002";
/** "Bajo del Río": declared 6 ha, drawn, measured 5,69 ha. */
const DRAWN = "0192f3a0-0004-7000-8000-000000000003";

function renderMap(plotId: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[`/parcelas/${plotId}/mapa`]}>
        <AuthProvider>
          <Routes>
            <Route path="/parcelas/:id/mapa" element={<PlotMapPage />} />
            <Route path="/parcelas/:id" element={<p>detalle</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** A square of about a hectare, in the coffee belt. Four corners, typed. */
const SQUARE: Array<[number, number]> = [
  [4.98, -75.605],
  [4.98, -75.604],
  [4.981, -75.604],
  [4.981, -75.605],
];

/** A bow tie: the same four corners, with two of them swapped. */
const BOWTIE: Array<[number, number]> = [
  [4.98, -75.605],
  [4.981, -75.604],
  [4.98, -75.604],
  [4.981, -75.605],
];

async function drawByTyping(
  user: ReturnType<typeof userEvent.setup>,
  corners: Array<[number, number]>,
) {
  for (let i = 0; i < corners.length; i++) {
    await user.click(screen.getByRole("button", { name: "Agregar esquina" }));
    const lat = screen.getByLabelText(`Latitud ${i + 1}`);
    const lon = screen.getByLabelText(`Longitud ${i + 1}`);
    await user.clear(lat);
    await user.type(lat, String(corners[i][0]));
    await user.clear(lon);
    await user.type(lon, String(corners[i][1]));
  }
}

beforeEach(() => {
  resetDb();
  setTokens({
    accessToken: "mock-access.0192f3a0-0001-7000-8000-000000000001.test",
    refreshToken: "mock-refresh.0192f3a0-0001-7000-8000-000000000001",
  });
});

describe("drawing a lot on the map", () => {
  it("measures the polygon as it is drawn and stores it, keeping both areas", async () => {
    const user = userEvent.setup();
    renderMap(UNDRAWN);

    expect(await screen.findByRole("heading", { name: /Polígono de La Cuchilla/ }))
      .toBeInTheDocument();
    // Nothing drawn: one figure, and the other honestly missing.
    expect(screen.getByText("del polígono (sin dibujar)")).toBeInTheDocument();

    await drawByTyping(user, SQUARE);

    // Roughly 1,1 ha: 0,001° of latitude by 0,001° of longitude at 4,98 N.
    expect(await screen.findByText(/Área del polígono: 1,2\d ha/)).toBeInTheDocument();
    expect(screen.getByText("del polígono (mientras dibuja)")).toBeInTheDocument();
    expect(screen.getByText(/la está calculando su navegador/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Guardar el polígono" }));

    expect(await screen.findByText(/quedó guardado y el servidor volvió a medir/))
      .toBeInTheDocument();
    // After the save the figure is the server's, and it says so.
    await waitFor(() =>
      expect(screen.getByText("medida del polígono")).toBeInTheDocument(),
    );
    // Both hectare figures survive: 2,75 declared next to what was measured.
    expect(screen.getByText("2,75 ha")).toBeInTheDocument();
    expect(screen.getByText("declarada por usted")).toBeInTheDocument();
  }, 20000);

  it("says INVALID_GEOMETRY in Spanish, on the drawing, before the server has to", async () => {
    const user = userEvent.setup();
    renderMap(UNDRAWN);
    await screen.findByRole("heading", { name: /Polígono de La Cuchilla/ });

    await drawByTyping(user, BOWTIE);

    expect(await screen.findByText(/se cruza a sí mismo/)).toBeInTheDocument();
    // No English, no code, no "error inesperado".
    expect(screen.queryByText(/Self-intersection/)).not.toBeInTheDocument();
    expect(screen.queryByText(/INVALID_GEOMETRY/)).not.toBeInTheDocument();
    // And no area, because a ring that crosses itself has none anybody agrees on.
    expect(screen.getByText("Área del polígono: sin calcular")).toBeInTheDocument();
  }, 20000);

  it("shows the two areas of a lot that already has a polygon, and the gap between them", async () => {
    renderMap(DRAWN);
    expect(await screen.findByRole("heading", { name: /Polígono de Bajo del Río/ }))
      .toBeInTheDocument();
    expect(await screen.findByText("6,00 ha")).toBeInTheDocument();
    expect(screen.getByText("5,69 ha")).toBeInTheDocument();
    expect(screen.getByText(/La diferencia es de 0,31 ha/)).toBeInTheDocument();
    // The difference is stated, never scolded about.
    expect(screen.getByText(/Es lo normal/)).toBeInTheDocument();
  }, 20000);

  it("warns about a lot drawn on top of another, and stores it anyway", async () => {
    const user = userEvent.setup();
    renderMap(UNDRAWN);
    await screen.findByRole("heading", { name: /Polígono de La Cuchilla/ });

    // "Bajo del Río" is drawn around 4,9795–4,9818 N / 75,6042–75,6066 O in the
    // seed. This square lands on top of it.
    await drawByTyping(user, [
      [4.9795, -75.6066],
      [4.9795, -75.6042],
      [4.9818, -75.6042],
      [4.9818, -75.6066],
    ]);
    await user.click(screen.getByRole("button", { name: "Guardar el polígono" }));

    expect(await screen.findByText(/se pisa con «Bajo del Río»/)).toBeInTheDocument();
    expect(screen.getByText(/No es un error y se guardó igual/)).toBeInTheDocument();
  }, 20000);

  it("says out loud that there are no tiles, rather than showing an empty grey box", async () => {
    renderMap(DRAWN);
    await screen.findByRole("heading", { name: /Polígono de Bajo del Río/ });
    expect(
      screen.getByText(/no puede pedir imágenes a servidores de internet/),
    ).toBeInTheDocument();
  }, 20000);

  it("draws the other lots of the farm behind, which is what replaces a photograph", async () => {
    renderMap(UNDRAWN);
    const canvas = await screen.findByRole("img", { name: /Mapa del lote/ });
    // The seed has two drawn lots; the one being edited is not its own neighbour.
    expect(within(canvas).getByText("Bajo del Río")).toBeInTheDocument();
    expect(within(canvas).getByText("El Alto")).toBeInTheDocument();
  }, 20000);
});
