// SPDX-License-Identifier: MIT
/**
 * The waiting screen's last edges: every step done but not yet ready, an
 * answer that lands after the screen was closed, and the seam that leaves
 * for the farm's own address.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { api } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import type { ProvisionStatus } from "../../api/types";
import { theme } from "../../theme";
import { ProvisionProgress, goTo } from "./ProvisionProgress";

const allDone = (): ProvisionStatus => ({
  slug: "lapalma",
  url: "https://lapalma.bascula.engp.io",
  dedicated: true,
  steps: [
    { key: "database", done: true },
    { key: "app", done: true },
    { key: "certificate", done: true },
    { key: "web", done: true },
  ],
  ready: false,
  slow: false,
  elapsedSeconds: 30,
});

function renderIt() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <ProvisionProgress slug="lapalma" pollMs={10} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.restoreAllMocks());

describe("every step done, not yet ready", () => {
  it("falls back to the opening sentence", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue(allDone());
    renderIt();
    expect(await screen.findByTestId("provision-current")).toHaveTextContent(
      "Estamos empezando.",
    );
  });
});

describe("an answer after the screen closed", () => {
  it("is ignored and nothing more is asked when it succeeds", async () => {
    const d = deferred<ProvisionStatus>();
    const spy = vi.spyOn(api, "provisionStatus").mockReturnValue(d.promise);
    const { unmount } = renderIt();
    unmount();
    d.resolve(allDone());
    await new Promise((r) => setTimeout(r, 40));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("is ignored and nothing more is asked when it fails", async () => {
    const d = deferred<ProvisionStatus>();
    const spy = vi.spyOn(api, "provisionStatus").mockReturnValue(d.promise);
    const { unmount } = renderIt();
    unmount();
    d.reject(new ApiError(404, { error: { code: "NOT_FOUND", message: "no" } }));
    await new Promise((r) => setTimeout(r, 40));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("leaving for the farm", () => {
  it("hands the address to the browser", () => {
    goTo.assign("#lista");
    expect(window.location.hash).toBe("#lista");
  });
});
