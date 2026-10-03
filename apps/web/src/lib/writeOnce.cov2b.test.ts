// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWriteOnce } from "./writeOnce";

describe("useWriteOnce.retire()", () => {
  it("with no intent forgets every id, so the next attempt carries a new one", async () => {
    const { result } = renderHook(() => useWriteOnce());
    const seen: string[] = [];
    const attempt = () =>
      act(async () => {
        await result.current
          .run("pago", async (mint) => {
            seen.push(mint());
            throw new Error("sin señal");
          })
          .catch(() => undefined);
      });
    await attempt();
    await attempt();
    expect(seen[1]).toBe(seen[0]);
    act(() => result.current.retire());
    await attempt();
    expect(seen[2]).not.toBe(seen[0]);
  });
});
