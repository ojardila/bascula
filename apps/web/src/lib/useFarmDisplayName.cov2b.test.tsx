// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/node";
import { useFarmDisplayName } from "./useFarmDisplayName";

describe("useFarmDisplayName", () => {
  it("settles with no name when the farm's name is blank", async () => {
    server.use(http.get("*/v1/farm-name", () => HttpResponse.json({ slug: "lapalma", name: "   " })));
    const { result } = renderHook(() => useFarmDisplayName("lapalma"));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.name).toBeNull();
  });

  it("is settled at once with no slug", () => {
    const { result } = renderHook(() => useFarmDisplayName(null));
    expect(result.current).toEqual({ name: null, settled: true });
  });
});
