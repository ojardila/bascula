// SPDX-License-Identifier: MIT
/**
 * The resume card does not offer a tour whose three parts are already done,
 * even when the tour itself was left for later rather than finished.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { TourProvider, useTour } from "./TourContext";
import { ResumeCard } from "./ResumeCard";

vi.mock("../../api/endpoints", () => ({
  api: {
    listTours: async () => [{ tour: "owner", step: 12, status: "later", updatedAt: "2026-10-01T12:00:00Z" }],
    saveTour: async () => ({}),
  },
}));

vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u-rc2", isSuperAdmin: false, farm: { id: "f-rc2", name: "El Roble" } },
    principal: { role: "owner", isSuperAdmin: false, farmStatus: "active" },
    readOnly: false,
  }),
}));

function Loaded() {
  return <div data-testid="loaded">{String(useTour().loaded)}</div>;
}

describe("ResumeCard", () => {
  it("stays away once the price, the people and the lotes are done", async () => {
    render(
      <TourProvider>
        <Loaded />
        <ResumeCard />
      </TourProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("loaded").textContent).toBe("true"));
    await act(async () => {});
    expect(screen.queryByRole("heading", { name: "Termine de preparar su finca" })).not.toBeInTheDocument();
  });
});
