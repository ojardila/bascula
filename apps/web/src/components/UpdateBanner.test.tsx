/**
 * The «versión nueva» banner: it appears only when the server serves another
 * build than the one this page runs, and a tap moves the page onto it.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ThemeProvider } from "@mui/material";
import { theme } from "../theme";
import * as appVersion from "../lib/appVersion";
import { isOutdated } from "../lib/appVersion";
import { UpdateBanner } from "./UpdateBanner";

vi.mock("../lib/appVersion", async (orig) => {
  const real = await orig<typeof import("../lib/appVersion")>();
  return { ...real, APP_VERSION: "0.2.40", fetchServerVersion: vi.fn(), applyUpdate: vi.fn() };
});


function renderBanner() {
  return render(
    <ThemeProvider theme={theme}>
      <UpdateBanner />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.mocked(appVersion.fetchServerVersion).mockReset();
  vi.mocked(appVersion.applyUpdate).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("isOutdated", () => {
  it("is true only for two real, different builds", () => {
    expect(isOutdated("0.2.40", "0.2.41")).toBe(true);
    expect(isOutdated("0.2.40", "0.2.40")).toBe(false);
    expect(isOutdated("0.2.40", null)).toBe(false);
    expect(isOutdated("dev", "0.2.41")).toBe(false);
    expect(isOutdated("0.2.40", "dev")).toBe(false);
  });
});

describe("UpdateBanner", () => {
  it("stays hidden while the page runs the server's build", async () => {
    vi.mocked(appVersion.fetchServerVersion).mockResolvedValue("0.2.40");
    renderBanner();
    await waitFor(() => expect(appVersion.fetchServerVersion).toHaveBeenCalled());
    expect(screen.queryByText(/versión nueva/)).not.toBeInTheDocument();
  });

  it("stays hidden when the server cannot be asked", async () => {
    vi.mocked(appVersion.fetchServerVersion).mockResolvedValue(null);
    renderBanner();
    await waitFor(() => expect(appVersion.fetchServerVersion).toHaveBeenCalled());
    expect(screen.queryByText(/versión nueva/)).not.toBeInTheDocument();
  });

  it("says so when the server has a newer build, and a tap updates", async () => {
    vi.mocked(appVersion.fetchServerVersion).mockResolvedValue("0.2.41");
    renderBanner();
    const btn = await screen.findByRole("button", { name: /Hay una versión nueva, toque para actualizar/ });
    fireEvent.click(btn);
    expect(appVersion.applyUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Actualizando…")).toBeInTheDocument();
  });

  it("asks again when the app comes back to the front", async () => {
    vi.mocked(appVersion.fetchServerVersion).mockResolvedValue("0.2.40");
    renderBanner();
    await waitFor(() => expect(appVersion.fetchServerVersion).toHaveBeenCalledTimes(1));
    vi.mocked(appVersion.fetchServerVersion).mockResolvedValue("0.2.41");
    window.dispatchEvent(new Event("pageshow"));
    expect(await screen.findByText(/versión nueva/)).toBeInTheDocument();
  });
});
