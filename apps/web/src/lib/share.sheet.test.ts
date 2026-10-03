import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareByWhatsApp } from "./share";

type ShareNav = { share?: (d: { text: string }) => Promise<void> };

function touchScreen(coarse: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({
      matches: coarse && q === "(pointer: coarse)",
      media: q,
    }),
  });
}

describe("shareByWhatsApp", () => {
  const nav = navigator as unknown as ShareNav;
  let open: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    open = vi.spyOn(window, "open").mockReturnValue({} as Window);
  });
  afterEach(() => {
    Reflect.deleteProperty(nav, "share");
    vi.restoreAllMocks();
  });

  it("uses the phone's share sheet when there is one", async () => {
    touchScreen(true);
    nav.share = vi.fn().mockResolvedValue(undefined);
    await expect(shareByWhatsApp("Pagado $10.000", "3001234567")).resolves.toBe(
      "shared",
    );
    expect(nav.share).toHaveBeenCalledWith({ text: "Pagado $10.000" });
    expect(open).not.toHaveBeenCalled();
  });

  it("reports a share sheet the person closed, without opening WhatsApp anyway", async () => {
    touchScreen(true);
    nav.share = vi
      .fn()
      .mockRejectedValue(new DOMException("closed", "AbortError"));
    await expect(shareByWhatsApp("x")).resolves.toBe("cancelled");
    expect(open).not.toHaveBeenCalled();
  });

  it("falls back to wa.me when the share sheet fails", async () => {
    touchScreen(true);
    nav.share = vi
      .fn()
      .mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    await expect(shareByWhatsApp("hola", "3001234567")).resolves.toBe("opened");
    expect(open).toHaveBeenCalledWith(
      "https://wa.me/573001234567?text=hola",
      "_blank",
      "noopener",
    );
  });

  it("ignores the share API on a computer and says when the tab was blocked", async () => {
    touchScreen(false);
    nav.share = vi.fn();
    open.mockReturnValue(null);
    await expect(shareByWhatsApp("hola")).resolves.toBe("failed");
    expect(nav.share).not.toHaveBeenCalled();
  });
});
