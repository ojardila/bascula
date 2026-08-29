/**
 * Material 3 in the same green the phone already uses.
 *
 * Why MUI and not Tailwind or a hand-rolled set of components: the mobile app
 * is react-native-paper, which is Material Design 3. MUI is the same design
 * language on the web, so the two halves of the product read as one product
 * without anybody maintaining a spec of what "our green" means. It also ships
 * the parts this sprint would otherwise have to build badly — data table,
 * autocomplete, dialog, date field, snackbar — and with ten modules queued
 * behind this one, the components are the deliverable, not the CSS.
 *
 * The palette is lifted verbatim from `apps/mobile/App.tsx` (#2e7d32) and the
 * receipt stylesheet (#1b5e20). Same hex, not "about the same green".
 */
import { createTheme } from "@mui/material/styles";
import { esES } from "@mui/material/locale";

export const GREEN = "#2e7d32";
export const GREEN_DARK = "#1b5e20";

export const theme = createTheme(
  {
    palette: {
      mode: "light",
      primary: { main: GREEN, dark: GREEN_DARK, contrastText: "#ffffff" },
      secondary: { main: "#6d4c41" }, // dried coffee parchment
      success: { main: GREEN },
      warning: { main: "#c08a17" },
      error: { main: "#b3261e" },
      background: { default: "#f6f7f4", paper: "#ffffff" },
      text: { primary: "#1a1c19", secondary: "#43483f" },
      divider: "#dde5da",
    },
    shape: { borderRadius: 12 },
    typography: {
      fontFamily: '"Roboto","Helvetica Neue",Arial,sans-serif',
      h1: { fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.01em" },
      h2: { fontSize: "1.375rem", fontWeight: 700 },
      h3: { fontSize: "1.125rem", fontWeight: 600 },
      button: { textTransform: "none", fontWeight: 600 },
      // Money is read across a desk, often by someone who is not looking for
      // it. It gets its own scale and tabular figures so columns line up.
      overline: { fontWeight: 700, letterSpacing: "0.08em" },
    },
    components: {
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: { root: { borderRadius: 10, paddingInline: 18 } },
      },
      MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
      MuiCard: {
        styleOverrides: {
          root: { border: "1px solid #e3e8e0", boxShadow: "0 1px 2px rgba(16,24,16,.05)" },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          head: {
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "#43483f",
            backgroundColor: "#f2f5f0",
          },
        },
      },
      MuiTextField: { defaultProps: { size: "small" } },
      MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
    },
  },
  esES,
);

/** Tabular numerals, for any element that shows a peso figure. */
export const moneyFont = {
  fontVariantNumeric: "tabular-nums",
  fontFeatureSettings: '"tnum"',
} as const;
