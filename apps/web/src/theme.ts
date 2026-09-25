/**
 * Material 3 in Báscula's green.
 *
 * Why MUI and not Tailwind or a hand-rolled set of components: the original
 * phone app (since retired) was react-native-paper, Material Design 3, and MUI
 * kept the same design language when the product moved to the web, without
 * anybody maintaining a spec of what "our green" means. It also ships
 * the parts this sprint would otherwise have to build badly — data table,
 * autocomplete, dialog, date field, snackbar — and with ten modules queued
 * behind this one, the components are the deliverable, not the CSS.
 *
 * The palette (#2e7d32, and #1b5e20 for figures on paper) is the one the
 * farms already knew from the retired phone app and its receipts. Same hex, not "about the same green".
 *
 * Type and control sizes lean large on purpose: the people who run the farm
 * on this screen, on a computer or a phone, are often around fifty and do not live in
 * software. Small type and tight buttons cost them more than they save us.
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
      fontSize: 16,
      h1: { fontSize: "2rem", fontWeight: 700, letterSpacing: "-0.01em" },
      h2: { fontSize: "1.5rem", fontWeight: 700 },
      h3: { fontSize: "1.25rem", fontWeight: 600 },
      body1: { fontSize: "1.0625rem", lineHeight: 1.5 },
      body2: { fontSize: "1rem", lineHeight: 1.45 },
      button: { textTransform: "none", fontWeight: 700, fontSize: "1.0625rem" },
      // Money is read across a desk, often by someone who is not looking for
      // it. It gets its own scale and tabular figures so columns line up.
      overline: { fontWeight: 700, letterSpacing: "0.08em" },
    },
    components: {
      MuiButton: {
        defaultProps: { disableElevation: true, size: "large" },
        styleOverrides: {
          root: {
            borderRadius: 12,
            paddingInline: 22,
            minHeight: 48,
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: { minWidth: 44, minHeight: 44 },
        },
      },
      MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
      MuiCard: {
        styleOverrides: {
          root: { border: "1px solid #e3e8e0", boxShadow: "0 1px 2px rgba(16,24,16,.05)" },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: { fontSize: 16, paddingBlock: 14 },
          head: {
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "#43483f",
            backgroundColor: "#f2f5f0",
          },
        },
      },
      // medium, not small: phone and web share the same people.
      MuiTextField: { defaultProps: { size: "medium" } },
      MuiChip: { styleOverrides: { root: { fontWeight: 600, fontSize: 14 } } },
      MuiListItemButton: {
        styleOverrides: {
          root: { minHeight: 52 },
        },
      },
    },
  },
  esES,
);

/** Tabular numerals, for any element that shows a peso figure. */
export const moneyFont = {
  fontVariantNumeric: "tabular-nums",
  fontFeatureSettings: '"tnum"',
} as const;
