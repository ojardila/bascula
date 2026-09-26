/**
 * Dialog buttons must never be squeezed into clipped, broken labels.
 *
 * The receipt dialog ("Pago registrado") has five actions in an xs dialog;
 * MUI's default DialogActions is a single non-wrapping row whose children
 * shrink, so "Ver el perfil" became three lines and "Enviar por WhatsApp"
 * was cut off. The rule now lives in the theme, for every dialog.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button, Dialog, DialogActions, ThemeProvider } from "@mui/material";
import type { CSSObject } from "@mui/material/styles";
import { theme } from "../theme";
import { ConfirmDialog } from "./ConfirmDialog";

type RootFn = (p: { theme: typeof theme }) => CSSObject;
const rootStyle = () =>
  (theme.components!.MuiDialogActions!.styleOverrides!.root as unknown as RootFn)({ theme });

describe("dialog actions layout (theme)", () => {
  it("wraps instead of shrinking the buttons", () => {
    const s = rootStyle();
    expect(s.flexWrap).toBe("wrap");
    expect(s["& > *"]).toMatchObject({ flexShrink: 0, maxWidth: "100%" });
  });

  it("stacks full width on a phone, primary (last in the markup) on top", () => {
    const phone = rootStyle()[theme.breakpoints.down("sm")] as CSSObject;
    expect(phone.flexDirection).toBe("column-reverse");
    expect(phone.alignItems).toBe("stretch");
    expect(phone["& > *"]).toMatchObject({ width: "100%" });
  });

  it("spaces with gap, not MUI's sibling margin that would misalign a stack", () => {
    expect(theme.components!.MuiDialogActions!.defaultProps).toMatchObject({ disableSpacing: true });
    render(
      <ThemeProvider theme={theme}>
        <Dialog open>
          <DialogActions data-testid="actions">
            <Button>Uno</Button>
            <Button>Dos</Button>
          </DialogActions>
        </Dialog>
      </ThemeProvider>,
    );
    expect(screen.getByTestId("actions").className).not.toMatch(/MuiDialogActions-spacing/);
  });

  it("keeps the large-text button style", () => {
    render(
      <ThemeProvider theme={theme}>
        <ConfirmDialog open title="¿Revocar la conexión?" body="…" confirmLabel="Revocar conexión"
          destructive onConfirm={() => {}} onCancel={() => {}} />
      </ThemeProvider>,
    );
    const btn = screen.getByRole("button", { name: "Revocar conexión" });
    expect(btn.className).toMatch(/MuiButton-sizeLarge/);
    expect(btn).toHaveTextContent(/^Revocar conexión$/);
  });
});
