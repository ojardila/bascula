// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadCsv, formatNumber, toCsv } from "./csv";

const { createObjectURL, revokeObjectURL } = URL;

describe("downloadCsv", () => {
  afterEach(() => {
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("saves the text as a named file and frees the object URL afterwards", async () => {
    vi.useFakeTimers();
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => {
      blobs.push(b);
      return "blob:csv-1";
    });
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    const csv = toCsv(["Nombre", "Kilos"], [["María", 12.5]]);
    expect(downloadCsv("cosecha.csv", csv)).toBe(true);

    expect(click).toHaveBeenCalledTimes(1);
    const clicked = click.mock.contexts[0] as HTMLAnchorElement;
    expect(clicked.download).toBe("cosecha.csv");
    expect(clicked.getAttribute("href")).toBe("blob:csv-1");
    // The link is only there for the click.
    expect(document.querySelector("a[download]")).toBeNull();
    expect(blobs[0].type).toBe("text/csv;charset=utf-8");
    expect(await blobs[0].text()).toContain("María;12,5");

    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith("blob:csv-1");
  });

  it("says so where the browser cannot make a file", () => {
    Object.assign(URL, {
      createObjectURL: () => {
        throw new Error("not supported");
      },
    });
    expect(downloadCsv("x.csv", "a")).toBe(false);
  });

  it("writes nothing for a number that is not one", () => {
    expect(formatNumber(Number.NaN)).toBe("");
    expect(formatNumber(Infinity)).toBe("");
  });
});
