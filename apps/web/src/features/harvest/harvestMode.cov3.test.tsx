// SPDX-License-Identifier: MIT
/**
 * `useHarvestMode` against a farm record that does not carry `harvestMode`
 * at all (a server from before the switch existed): that is "off", and the
 * head start kept in this browser is corrected to say so.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider, useAuth } from "../../auth/AuthContext";
import { api } from "../../api/endpoints";
import { FARM_ID } from "../../mocks/db";
import { signInOwner } from "../../test/renderWithAuth";
import { useHarvestMode } from "./harvestMode";

const CACHE = `bascula.harvestMode.${FARM_ID}`;

function C3wReady({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user ? <>{children}</> : null;
}
const c3wWrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    <AuthProvider>
      <C3wReady>{children}</C3wReady>
    </AuthProvider>
  </MemoryRouter>
);

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("useHarvestMode", () => {
  it("reads a farm record without the field as off and rewrites the cache", async () => {
    signInOwner();
    localStorage.setItem(CACHE, "1");
    const real = await api.getFarm();
    const { harvestMode: _dropped, ...older } = real;
    vi.spyOn(api, "getFarm").mockResolvedValue(older as typeof real);

    const { result } = renderHook(() => useHarvestMode(), { wrapper: c3wWrapper });
    await waitFor(() => expect(result.current?.on).toBe(false));
    expect(localStorage.getItem(CACHE)).toBe("0");
  });
});
