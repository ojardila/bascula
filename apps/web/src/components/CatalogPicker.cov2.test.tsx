// SPDX-License-Identifier: MIT
/**
 * The catalogue picker: typing a name that already exists does not offer to
 * add it again, picking an option replaces the typed text, and clearing it
 * empties the value.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { CatalogPicker, type CatalogValue } from "./CatalogPicker";

const OPTIONS = [
  { id: "c1", name: "Bulto" },
  { id: "c2", name: "Caja" },
];

function Harness({ spy }: { spy: (v: CatalogValue | null) => void }) {
  const [value, setValue] = useState<CatalogValue | null>(null);
  return (
    <>
    <button type="button" onClick={() => setValue({ id: "c2", name: "Caja" })}>
      Usar caja
    </button>
    <CatalogPicker
      label="Categoría"
      addWhat="categoría"
      options={OPTIONS}
      value={value}
      onChange={(v) => {
        spy(v);
        setValue(v);
      }}
    />
    </>
  );
}

describe("CatalogPicker", () => {
  it("does not offer to add a name the catalogue already has", async () => {
    const user = userEvent.setup();
    render(<Harness spy={() => {}} />);
    await user.type(screen.getByLabelText("Categoría"), "caja");
    expect(await screen.findByRole("option", { name: "Caja" })).toBeInTheDocument();
    expect(screen.queryByText(/Agregar/)).not.toBeInTheDocument();
  });

  it("offers to add a new one, and clears back to nothing", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const input = screen.getByLabelText("Categoría");
    await user.type(input, "Saco");
    await user.click(await screen.findByRole("option", { name: "Agregar categoría «Saco»" }));
    expect(spy).toHaveBeenLastCalledWith({ id: null, name: "Saco" });
    expect(input).toHaveValue("Saco");

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(spy).toHaveBeenLastCalledWith(null);
    expect(input).toHaveValue("");
  });

  it("keeps what the person is typing when the form sets the value underneath", async () => {
    const user = userEvent.setup();
    render(<Harness spy={() => {}} />);
    const input = screen.getByLabelText("Categoría");
    await user.type(input, "Sa");
    // A click that does not take the focus away, as a form reset would.
    fireEvent.click(screen.getByRole("button", { name: "Usar caja" }));
    expect(input).toHaveValue("Sa");
  });

  it("picking an existing option names it in the field", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const input = screen.getByLabelText("Categoría");
    await user.click(input);
    await user.click(await screen.findByRole("option", { name: "Bulto" }));
    expect(spy).toHaveBeenLastCalledWith({ id: "c1", name: "Bulto" });
    expect(input).toHaveValue("Bulto");
  });
});
