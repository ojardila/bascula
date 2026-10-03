// SPDX-License-Identifier: MIT
/**
 * mode.ts reads its flags at import time, so each case stubs the environment
 * and imports a fresh copy of the module.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function freshMode() {
  vi.resetModules();
  return import("./mode");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("apiMode / announceApiMode", () => {
  it("in mock mode says so, and warns that a configured server is ignored", async () => {
    vi.stubEnv("VITE_USE_MOCKS", "true");
    vi.stubEnv("VITE_API_URL", "http://localhost:8099");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mode = await freshMode();

    expect(mode.apiMode()).toEqual({
      mocks: true,
      label: "Datos simulados",
      target: "MSW (en el navegador)",
    });
    mode.announceApiMode();
    expect(info).toHaveBeenCalledWith(
      "%cBáscula · Datos simulados%c → MSW (en el navegador)",
      expect.stringContaining("#8a6d00"),
      "",
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("VITE_USE_MOCKS=true gana sobre VITE_API_URL"));
  });

  it("in mock mode without a server configured does not warn", async () => {
    vi.stubEnv("VITE_USE_MOCKS", "true");
    vi.stubEnv("VITE_API_URL", "");
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mode = await freshMode();
    mode.announceApiMode();
    expect(warn).not.toHaveBeenCalled();
  });

  it("against the real API names the base URL when one is set", async () => {
    vi.stubEnv("VITE_USE_MOCKS", "false");
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mode = await freshMode();

    expect(mode.apiMode()).toEqual({
      mocks: false,
      label: "API real",
      target: "https://api.example.test",
    });
    mode.announceApiMode();
    expect(info).toHaveBeenCalledWith(
      "%cBáscula · API real%c → https://api.example.test",
      expect.stringContaining("#1b5e20"),
      "",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("against the real API through the proxy names the proxy target", async () => {
    vi.stubEnv("VITE_USE_MOCKS", "false");
    vi.stubEnv("VITE_API_BASE_URL", "");
    vi.stubEnv("VITE_API_URL", "http://srv:9000");
    const mode = await freshMode();
    expect(mode.apiMode().target).toBe("http://srv:9000 (vía proxy de Vite)");
  });
});
