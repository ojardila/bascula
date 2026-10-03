// SPDX-License-Identifier: MIT
/** Going to the background does not ask the server for its build. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { ThemeProvider } from "@mui/material";
import { theme } from "../theme";
import * as appVersion from "../lib/appVersion";
import { UpdateBanner } from "./UpdateBanner";

vi.mock("../lib/appVersion", async (orig) => {
  const real = await orig<typeof import("../lib/appVersion")>();
  return { ...real, APP_BUILD: "b-0240", fetchServerVersion: vi.fn(), applyUpdate: vi.fn() };
});

function setVisibility(v: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
}

afterEach(() => {
  setVisibility("visible");
  vi.restoreAllMocks();
});

describe("UpdateBanner visibility", () => {
  it("checks when the page comes back, not when it is hidden", async () => {
    vi.mocked(appVersion.fetchServerVersion).mockResolvedValue({ version: "v0.2.40", build: "b-0240" });
    render(
      <ThemeProvider theme={theme}>
        <UpdateBanner />
      </ThemeProvider>,
    );
    await waitFor(() => expect(appVersion.fetchServerVersion).toHaveBeenCalledTimes(1));

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(appVersion.fetchServerVersion).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(appVersion.fetchServerVersion).toHaveBeenCalledTimes(2));
  });
});
