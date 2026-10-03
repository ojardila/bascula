import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";

const host = vi.hoisted(() => ({ farm: false }));
vi.mock("../../lib/farmHost", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/farmHost")>();
  return { ...real, showsFarmEntry: () => host.farm };
});

function renderApp(path = "/") {
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

let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  host.farm = false;
  setTokens(null);
  invalidateRefs();
  localStorage.clear();
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const section = async () => (await screen.findByRole("heading", { level: 2, name: "Véalo funcionando" })).closest("section") as HTMLElement;
const videos = (root: HTMLElement) => Array.from(root.querySelectorAll("video"));

describe("«Véalo funcionando» on the landing", () => {
  it("downloads nothing and plays nothing until asked, with MP4, WebM, poster and Spanish captions", async () => {
    renderApp();
    const all = videos(await section());
    expect(all).toHaveLength(3);
    const [main, payment, tour] = all;
    for (const v of all) {
      expect(v.getAttribute("preload")).toBe("none");
      expect(v.hasAttribute("autoplay")).toBe(false);
      expect(v.hasAttribute("playsinline")).toBe(true);
      const types = Array.from(v.querySelectorAll("source")).map((s) => s.getAttribute("type"));
      expect(types).toEqual(["video/webm", "video/mp4"]);
      const track = v.querySelector("track")!;
      expect(track.getAttribute("srclang")).toBe("es");
      expect(track.getAttribute("kind")).toBe("captions");
      expect(track.getAttribute("src")).toMatch(/\.vtt/);
    }
    // The narrated explainer is the main video.
    expect(main.getAttribute("poster")).toMatch(/demo-3-poster/);
    expect(main.querySelector('source[type="video/mp4"]')!.getAttribute("src")).toMatch(/demo-3/);
    // The shorter videos do not even fetch their posters until opened.
    expect(payment.hasAttribute("poster")).toBe(false);
    expect(tour.hasAttribute("poster")).toBe(false);
    expect(play).not.toHaveBeenCalled();
  });

  it("says the main video is narrated, and the others have music without a voice", async () => {
    renderApp();
    const root = await section();
    expect(root).toHaveTextContent(/una voz le explica paso a paso/);
    expect(root).not.toHaveTextContent(/Tiene música; los textos van en pantalla/);
  });

  it("one big button plays the narrated explainer with sound, from the tap itself", async () => {
    const user = userEvent.setup();
    renderApp();
    const root = await section();
    const [main] = videos(root);
    expect(main.hasAttribute("controls")).toBe(false);
    await user.click(screen.getByRole("button", { name: /^Reproducir con sonido: Video narrado: cómo funciona Báscula.*\(1 min 28 s\)$/ }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.contexts[0]).toBe(main);
    expect(main.muted).toBe(false);
    expect(main.hasAttribute("controls")).toBe(true);
  });

  it("the payment video sits behind its own button and starts with sound when opened", async () => {
    const user = userEvent.setup();
    renderApp();
    const root = await section();
    const [, payment] = videos(root);
    await user.click(screen.getByRole("button", { name: "Ver el pago a un recolector (45 s)" }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.contexts[0]).toBe(payment);
    expect(payment.muted).toBe(false);
    expect(payment.getAttribute("poster")).toMatch(/demo-1-poster/);
  });

  it("the full tour sits behind its own button and starts with sound when opened", async () => {
    const user = userEvent.setup();
    renderApp();
    const root = await section();
    const [, , tour] = videos(root);
    await user.click(screen.getByRole("button", { name: "Ver el recorrido completo (1 min)" }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.contexts[0]).toBe(tour);
    expect(tour.muted).toBe(false);
    expect(tour.getAttribute("poster")).toMatch(/demo-2-poster/);
  });

  it("a phone held upright gets the vertical cut of the payment video", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("max-width") && q.includes("portrait"), media: q, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }));
    const user = userEvent.setup();
    renderApp();
    const [main, payment] = videos(await section());
    expect(main.querySelector('source[type="video/mp4"]')!.getAttribute("src")).toMatch(/demo-3/);
    expect(payment.querySelector('source[type="video/mp4"]')!.getAttribute("src")).toMatch(/demo-1-vertical/);
    await user.click(screen.getByRole("button", { name: "Ver el pago a un recolector (40 s)" }));
    expect(payment.getAttribute("poster")).toMatch(/demo-1-vertical-poster/);
  });

  it("never appears on a farm's own address", async () => {
    host.farm = true;
    renderApp();
    expect(await screen.findByText("Bienvenido")).toBeInTheDocument();
    expect(screen.queryByText("Véalo funcionando")).not.toBeInTheDocument();
    expect(document.querySelector("video")).toBeNull();
  });
});
