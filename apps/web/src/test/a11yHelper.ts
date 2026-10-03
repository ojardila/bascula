/**
 * ── A ONE-LINE axe-core ASSERTION FOR SCREEN-LEVEL TESTS ───────────────────
 *
 * `await expectNoAxeViolations(container)` runs axe-core against a rendered
 * container and fails with the list of violations as the message. The scope
 * is deliberately narrow — the rules we can trust in jsdom:
 *
 *   - WCAG 2.1 A and AA
 *   - best-practice (heading-order and friends)
 *
 * `color-contrast` is excluded. jsdom does not compute styles, so the rule
 * reports every check as "incomplete" and the result is a known hole, not an
 * authoritative pass. Contrast is a Playwright check, not a vitest one.
 *
 * The caller is responsible for mounting the component with the providers
 * that production uses (theme, router, auth, landmarks). This helper only
 * runs the scan and formats the report.
 */
import { expect } from "vitest";
import axe from "axe-core";

const RULE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

export interface A11yOptions {
  /**
   * Rules to turn OFF for this scan. Use for a single documented reason, not
   * to silence findings that should be fixed. The rule id is the one axe
   * prints — `heading-order`, `region`, `color-contrast`.
   */
  disable?: string[];
}

export async function expectNoAxeViolations(
  container: HTMLElement,
  options: A11yOptions = {},
): Promise<void> {
  const disabled = new Set<string>(options.disable ?? []);
  // `color-contrast` always goes off: jsdom cannot measure it.
  disabled.add("color-contrast");

  const result = await axe.run(container, {
    runOnly: { type: "tag", values: RULE_TAGS },
    rules: Object.fromEntries(
      Array.from(disabled, (id) => [id, { enabled: false }]),
    ),
  });

  if (result.violations.length === 0) return;

  const report = result.violations
    .map((v) => {
      const where = v.nodes
        .map((n) => `    target: ${n.target.join(" ")}`)
        .join("\n");
      return `  [${v.impact ?? "n/a"}] ${v.id} — ${v.help}\n${where}`;
    })
    .join("\n\n");

  expect.fail(
    `axe-core found ${result.violations.length} violation(s):\n\n${report}`,
  );
}
