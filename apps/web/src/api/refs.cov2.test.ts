// SPDX-License-Identifier: MIT
/** Reference data: a work unit with no short code is named by its label. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/node";
import { setTokens } from "./client";
import { invalidateRefs, loadRefs } from "./refs";

beforeEach(() => {
  invalidateRefs();
  setTokens({ accessToken: "a", refreshToken: "r" });
});
afterEach(() => {
  invalidateRefs();
  setTokens(null);
});

describe("loadRefs", () => {
  it("falls back to the unit's label when its code is empty", async () => {
    server.use(
      http.get("*/v1/workers", () => HttpResponse.json({ items: [] })),
      http.get("*/v1/activities", () => HttpResponse.json({ items: [] })),
      http.get("*/v1/plots", () => HttpResponse.json({ items: [] })),
      http.get("*/v1/catalogs/work-units", () =>
        HttpResponse.json({
          items: [
            { id: "u1", code: "", label: "Bulto" },
            { id: "u2", code: "kg", label: "Kilo" },
          ],
        }),
      ),
    );
    const refs = await loadRefs();
    expect(refs.units.get("u1")).toBe("Bulto");
    expect(refs.units.get("u2")).toBe("kg");
  });
});
