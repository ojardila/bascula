// SPDX-License-Identifier: MIT
/**
 * The bar's plural wording: several weighings waiting, several refused.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { PendingWeighing } from "./store";

const pending = (id: string, error: string | null): PendingWeighing => ({
  id,
  farmId: "f",
  input: {} as PendingWeighing["input"],
  who: "José",
  plot: "Mirador",
  kg: 10,
  day: "2026-09-21",
  createdAt: `2026-09-21T10:00:0${id}Z`,
  error,
});

vi.mock("./OfflineContext", () => ({
  useOffline: () => ({
    online: true,
    pending: [pending("1", null), pending("2", null), pending("3", "no"), pending("4", "no")],
    syncing: false,
    canQueue: true,
    enqueue: async () => {},
    remove: async () => {},
    flush: async () => null,
  }),
}));

const { OfflineBar, pendingLabel } = await import("./OfflineBar");

describe("OfflineBar, several of each", () => {
  it("counts waiting and refused weighings in the plural", () => {
    render(
      <MemoryRouter>
        <OfflineBar />
      </MemoryRouter>,
    );
    expect(screen.getByText("2 pesadas por subir")).toBeInTheDocument();
    expect(screen.getByText("2 pesadas no se pudieron subir.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Subir ahora" })).toBeEnabled();
  });

  it("says one in the singular", () => {
    expect(pendingLabel(1)).toBe("1 pesada por subir");
  });
});
