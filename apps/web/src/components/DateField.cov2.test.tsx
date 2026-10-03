// SPDX-License-Identifier: MIT
/** Leaving the date field with nothing understood leaves the text alone. */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@mui/material";
import { useState } from "react";
import { DateField } from "./DateField";
import { AuthProvider } from "../auth/AuthContext";
import { theme } from "../theme";

function Harness() {
  const [value, setValue] = useState("");
  return (
    <ThemeProvider theme={theme}>
      <AuthProvider>
        <DateField label="Fecha" value={value} onChange={setValue} />
        <button type="button">Otro</button>
      </AuthProvider>
    </ThemeProvider>
  );
}

describe("DateField on blur", () => {
  it("keeps half-typed text as it is and says it is not a date", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText(/^Fecha/);
    await user.type(input, "45/1");
    await user.click(screen.getByRole("button", { name: "Otro" }));
    expect(input).toHaveValue("45/1");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("leaves an empty field empty", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText(/^Fecha/);
    await user.click(input);
    await user.click(screen.getByRole("button", { name: "Otro" }));
    expect(input).toHaveValue("");
  });
});
