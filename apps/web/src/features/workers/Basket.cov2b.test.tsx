// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BasketChip, BasketTile } from "./Basket";

describe("Basket", () => {
  it("shows a long basket number in its tile", () => {
    render(
      <>
        <BasketTile tag="123-456" />
        <BasketTile tag="123" />
        <BasketTile tag="46-63" />
      </>,
    );
    expect(screen.getByRole("img", { name: "Canasto 123" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Canasto 46-63" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Canasto 123-456" })).toHaveTextContent("123-456");
  });

  it("shows the big chip with the number", () => {
    render(<BasketChip tag=" 46 " big />);
    expect(screen.getByText("Canasto 46")).toBeInTheDocument();
  });

  it("shows the plain chip, or «Sin canasto» when there is no number", () => {
    render(
      <>
        <BasketChip tag="7" />
        <BasketChip tag="  " />
      </>,
    );
    expect(screen.getByText("Canasto 7")).toBeInTheDocument();
    expect(screen.getByText("Sin canasto")).toBeInTheDocument();
  });
});
