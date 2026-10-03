// SPDX-License-Identifier: MIT
/**
 * «Lo que hicieron los asistentes» with what the labels do not cover: a list
 * that could not load, a tool and an outcome with no Spanish name, a row with
 * no person or assistant name, and a farm timezone the browser rejects.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { McpActivityCard } from "./McpActivityCard";
import { AuthProvider } from "../../auth/AuthContext";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";
import { signInOwner } from "../../test/renderWithAuth";

function renderCard() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <McpActivityCard />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => signInOwner());

describe("McpActivityCard", () => {
  it("says the list could not be loaded", async () => {
    server.use(
      http.get("*/v1/mcp/activity", () =>
        HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
      ),
    );
    renderCard();
    expect(
      await screen.findByText("No pudimos cargar esta lista. Intente más tarde."),
    ).toBeInTheDocument();
  });

  it("shows unknown tools and outcomes as they came, and fills in missing names", async () => {
    db.farmOf(db.FARM_ID)!.timezone = "Marte/Olimpo";
    server.use(
      http.get("*/v1/mcp/activity", () =>
        HttpResponse.json({
          items: [
            {
              id: "x1",
              userId: "u",
              userName: "",
              clientId: null,
              clientName: "",
              tool: "plant_trees",
              outcome: "pending",
              summary: "",
              args: {},
              createdAt: "2026-09-01T15:00:00Z",
            },
          ],
        }),
      ),
    );
    renderCard();
    expect(await screen.findByText("plant_trees")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.getByText(/· Usuario · Asistente/)).toBeInTheDocument();
  });
});
