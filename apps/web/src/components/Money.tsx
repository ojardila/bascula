import { Box, type SxProps, type Theme } from "@mui/material";
import { formatMoney, formatMoneySigned } from "../lib/money";
import { moneyFont } from "../theme";

interface Props {
  cents: number;
  /** Show an explicit + / − . For ledger rows, where direction is the point. */
  signed?: boolean;
  /** Colour by direction: green for money in, red for money out. */
  colored?: boolean;
  variant?: "inherit" | "big" | "small";
  sx?: SxProps<Theme>;
}

const FONT_SIZE: Record<NonNullable<Props["variant"]>, string | undefined> = {
  big: "1.9rem",
  small: "0.8125rem",
  inherit: undefined,
};

function signColor(cents: number): string {
  return cents < 0 ? "error.main" : "success.dark";
}

/**
 * Every peso figure on screen goes through here.
 *
 * Not for the styling — for the guarantee that no component ever divides by
 * 100 on its own. Tabular numerals so columns of money line up; a stack of
 * right-aligned amounts that jitters is a stack nobody can scan.
 */
export function Money({ cents, signed, colored, variant = "inherit", sx }: Readonly<Props>) {
  const text = signed ? formatMoneySigned(cents) : formatMoney(cents);
  return (
    <Box
      component="span"
      sx={{
        ...moneyFont,
        whiteSpace: "nowrap",
        fontWeight: variant === "big" ? 700 : 600,
        fontSize: FONT_SIZE[variant],
        lineHeight: variant === "big" ? 1.1 : undefined,
        color: colored ? signColor(cents) : undefined,
        ...sx,
      }}
    >
      {text}
    </Box>
  );
}
