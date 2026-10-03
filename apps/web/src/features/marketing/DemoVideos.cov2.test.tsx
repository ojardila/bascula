// SPDX-License-Identifier: MIT
/**
 * The demo player on its own: a browser that refuses to play keeps the native
 * controls, the big button comes back when the video ends, and a start that
 * arrives after the player is gone does nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@mui/material";
import { CLIPS, DemoPlayer, type PlayerHandle } from "./DemoVideos";
import { theme } from "../../theme";

afterEach(() => vi.restoreAllMocks());

const clip = Object.values(CLIPS)[0];
const button = () =>
  screen.getByRole("button", { name: new RegExp(`^Reproducir con sonido: `) });

function renderPlayer(ref = createRef<PlayerHandle>()) {
  const view = render(
    <ThemeProvider theme={theme}>
      <DemoPlayer ref={ref} clip={clip} />
    </ThemeProvider>,
  );
  return { ...view, ref };
}

describe("DemoPlayer", () => {
  it("keeps the native controls when the browser refuses to play", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(() => Promise.reject(new Error("NotAllowedError")));
    const user = userEvent.setup();
    const { container } = renderPlayer();
    await user.click(button());
    expect(play).toHaveBeenCalledTimes(1);
    expect(container.querySelector("video")!.hasAttribute("controls")).toBe(true);
  });

  it("brings the big button back when the video ends", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    const user = userEvent.setup();
    const { container } = renderPlayer();
    await user.click(button());
    expect(screen.queryByRole("button", { name: /^Reproducir con sonido/ })).toBeNull();
    fireEvent.ended(container.querySelector("video")!);
    expect(button()).toBeInTheDocument();
  });

  it("does nothing when asked to start after the player is gone", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play");
    const { ref, unmount } = renderPlayer();
    const handle = ref.current!;
    unmount();
    act(() => handle.start());
    expect(play).not.toHaveBeenCalled();
  });
});
