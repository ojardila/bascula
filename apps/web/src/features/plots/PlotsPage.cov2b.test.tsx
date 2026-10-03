// SPDX-License-Identifier: MIT
/**
 * A drawn plot nobody declared the area of: the tooltip on its computed
 * figure says so instead of inventing a number.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { PlotsPage } from "./PlotsPage";
import { invalidateRefs } from "../../api/refs";
import * as db from "../../mocks/db";
import { renderWithAuth, signInOwner } from "../../test/renderWithAuth";

beforeEach(() => {
  signInOwner();
  invalidateRefs();
});

describe("a drawn plot with no declared area", () => {
  it("says the declared area is missing next to the computed one", async () => {
    const alto = db.tenantOf(db.FARM_ID)!.plots.find((p) => p.name === "El Alto")!;
    alto.areaHa = null;
    renderWithAuth(<PlotsPage />, { path: "/lotes" });
    expect(
      (await screen.findAllByLabelText(
        "Declarada sin declarar · calculada del polígono 4,04 ha",
      )).length,
    ).toBeGreaterThan(0);
  });
});
