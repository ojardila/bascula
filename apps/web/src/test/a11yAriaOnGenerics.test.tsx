/**
 * ── aria-label ON A PLAIN DIV OR SPAN IS IGNORED BY SOME SCREEN READERS ────
 *
 * The accessibility API only exposes `aria-label` on elements that have a
 * role — a `<button>`, an `<img>`, something with `role="…"`. Painting it on
 * a bare `<div>` or `<span>` is "aria-prohibited": NVDA sees nothing, VoiceOver
 * sometimes announces it as plain text, and axe flags it with WCAG 4.1.2.
 *
 * Two sites in this app put `aria-label` on a plain Box:
 *
 *   - `BasketTile` renders a square badge with a canasto number. The label
 *     is "Canasto 31" — the whole point for a screen reader. Without a role
 *     the label is lost and the reader hears either nothing or two separate
 *     chunks of text ("canasto" and "31") with no cue they belong together.
 *   - `Unknown` in `features/harvest/Figures.tsx` paints a dash — "—" — with
 *     a tooltip that spells out why the figure is unknown. For a sighted
 *     user the tooltip arrives on hover. For a screen reader the entire
 *     explanation lives in the `aria-label` on the span, which is also
 *     prohibited.
 *
 * Fix: give both a role that permits a label — `role="img"` fits because
 * the content is a self-contained graphic unit. This test fails before the
 * fix because at least one element with `aria-label` has no role attribute
 * and is not a natively labellable element.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ThemeProvider } from "@mui/material";
import { BasketTile } from "../features/workers/Basket";
import { Value } from "../features/harvest/Figures";
import { NO_TOTALS } from "../features/harvest/totals";
import { theme } from "../theme";

/**
 * Elements that natively accept `aria-label` without needing an explicit
 * role. Everything else must carry a `role` for the label to be exposed.
 * Scope kept narrow: this list is what we actually render in the two sites
 * under test. (See https://w3c.github.io/html-aria/ for the full matrix.)
 */
const LABELLABLE = new Set([
  "a",
  "button",
  "img",
  "input",
  "select",
  "textarea",
  "iframe",
  "link",
  "svg",
  "th",
  "td",
]);

function prohibitedLabels(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll("[aria-label]")).filter((el) => {
    if (el.hasAttribute("role")) return false;
    return !LABELLABLE.has(el.tagName.toLowerCase());
  });
}

describe("aria-label only on roles that permit it", () => {
  it("BasketTile labels a role-bearing element", () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <BasketTile tag="31" />
      </ThemeProvider>,
    );
    expect(prohibitedLabels(container)).toEqual([]);
  });

  it("Figures.Unknown labels a role-bearing element", () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <Value total={NO_TOTALS} />
      </ThemeProvider>,
    );
    expect(prohibitedLabels(container)).toEqual([]);
  });

  it("Figures.Note (provisional) labels a role-bearing element", () => {
    // valueIsEstimate = true with everything priced -> `estimate` state ->
    // renders Note with the Provisional tooltip, which MUI copies to the
    // child as `aria-label`.
    const total = {
      records: 1,
      kg: 10,
      recordsNotInKg: 0,
      valueCents: 50_000_00,
      recordsWithoutValue: 0,
      valueIsEstimate: true,
      recordsSpanningWeeks: 0,
    };
    const { container } = render(
      <ThemeProvider theme={theme}>
        <Value total={total} />
      </ThemeProvider>,
    );
    expect(prohibitedLabels(container)).toEqual([]);
  });
});
