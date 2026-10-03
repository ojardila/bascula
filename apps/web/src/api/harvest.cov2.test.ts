// SPDX-License-Identifier: MIT
/** The query-string builder behind every report route. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/node";
import { setTokens } from "./client";
import { reportWeeks } from "./harvest";

let seen: string[] = [];

beforeEach(() => {
  seen = [];
  setTokens({ accessToken: "a", refreshToken: "r" });
  server.use(
    http.get("*/v1/reports/weeks", ({ request }) => {
      seen.push(new URL(request.url).search);
      return HttpResponse.json({ items: [] });
    }),
  );
});

afterEach(() => setTokens(null));

describe("report query strings", () => {
  it("sends no '?' at all when every parameter is absent", async () => {
    await reportWeeks();
    await reportWeeks({ from: undefined, limit: undefined });
    expect(seen).toEqual(["", ""]);
  });

  it("keeps only the parameters that were given", async () => {
    await reportWeeks({ from: "2026-08-03", to: undefined, limit: 4 });
    expect(seen).toEqual(["?from=2026-08-03&limit=4"]);
  });
});
