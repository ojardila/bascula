// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { deviceLabel, isMobileAgent } from "./deviceLabel";

const UA = {
  androidChrome:
    "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0",
  macFirefox:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36",
};

describe("deviceLabel", () => {
  it("names the common browsers and devices in Spanish", () => {
    expect(deviceLabel(UA.androidChrome)).toBe("Chrome en Android");
    expect(deviceLabel(UA.iphoneSafari)).toBe("Safari en iPhone");
    expect(deviceLabel(UA.iphoneChrome)).toBe("Chrome en iPhone");
    expect(deviceLabel(UA.windowsEdge)).toBe("Edge en Windows");
    expect(deviceLabel(UA.macFirefox)).toBe("Firefox en Mac");
    expect(deviceLabel(UA.samsung)).toBe("Samsung Internet en Android");
  });

  it("says what it knows and no more", () => {
    expect(deviceLabel("okhttp/4.12")).toBe("Dispositivo desconocido");
    expect(deviceLabel("")).toBe("Dispositivo desconocido");
    expect(deviceLabel("Something (Linux)")).toBe("Linux");
  });

  it("tells phones from computers", () => {
    expect(isMobileAgent(UA.androidChrome)).toBe(true);
    expect(isMobileAgent(UA.iphoneSafari)).toBe(true);
    expect(isMobileAgent(UA.windowsEdge)).toBe(false);
  });
});
