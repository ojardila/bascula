// SPDX-License-Identifier: MIT
/**
 * The design system owes the farms a palette whose text reads. Two
 * places were below WCAG 2.1 AA (4.5:1):
 *
 *  - `theme.palette.warning.main` ("#c08a17"), used as the TEXT color of
 *    every outlined "provisional" chip (ActivitiesPage, PayWorkerPage,
 *    CrewPayrollPage, SettlementDetailPage, WorkRecordsPage): about 3:1
 *    against white.
 *  - The `BigAction` card's hint on `/cosecha` ("Un día, todos los
 *    empleados a la vez" / "Una persona, una pesada") paints `#fff` at
 *    `opacity: 0.9` over `primary.main`, which the browser flattens to a
 *    pale green that reads 4.49:1 against the card — one hundredth under
 *    the threshold.
 *
 * The test asserts the invariant, not the pixels: the warning swatch
 * reads on paper, and the hint color read on a brand card reads too.
 */
import { describe, expect, it } from "vitest";
import { theme } from "../theme";
import { BIG_ACTION_HINT_OPACITY } from "../features/harvest/CosechaHome";

type RGB = [number, number, number];

function parseHex(hex: string): RGB {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relLuminance([r, g, b]: RGB): number {
  const chan = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrast(a: string, b: string): number {
  const la = relLuminance(parseHex(a));
  const lb = relLuminance(parseHex(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function blend(fg: string, bg: string, alpha: number): string {
  const [fr, fg_, fb] = parseHex(fg);
  const [br, bg_, bb] = parseHex(bg);
  const mix = (f: number, b: number) =>
    Math.round(alpha * f + (1 - alpha) * b);
  const r = mix(fr, br);
  const g = mix(fg_, bg_);
  const b = mix(fb, bb);
  return (
    "#" +
    [r, g, b]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

describe("WCAG 2.1 AA — normal-size text (≥ 4.5:1)", () => {
  it("warning.main reads on paper", () => {
    const ratio = contrast(theme.palette.warning.main, "#ffffff");
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('BigAction hint reads on the green card ("primary.main")', () => {
    // CosechaHome.tsx: <Typography sx={{ opacity: 0.9 }}> {hint} </Typography>
    //   inside a <ButtonBase sx={{ bgcolor: 'primary.main', color: '#fff' }}>.
    // The browser flattens `#fff` at that opacity against the card.
    const hintColor = blend(
      "#ffffff",
      theme.palette.primary.main,
      BIG_ACTION_HINT_OPACITY,
    );
    const ratio = contrast(hintColor, theme.palette.primary.main);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
