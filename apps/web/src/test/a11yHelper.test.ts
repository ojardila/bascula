/**
 * ── THE axe-core HELPER MUST FAIL ON KNOWN DEFECTS AND PASS ON CLEAN DOM ──
 *
 * This is the test that keeps the helper honest: give it a container with a
 * known axe violation and it must report it; give it a clean container and
 * it must pass. If either side flips, the helper is lying, and silent passes
 * are the worst outcome for an accessibility check.
 */
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "./a11yHelper";

function containerFrom(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("expectNoAxeViolations", () => {
  it("fails when the container has an image with no accessible name", async () => {
    const container = containerFrom('<img src="x.png">');
    await expect(expectNoAxeViolations(container)).rejects.toThrow(
      /image-alt/,
    );
  });

  it("passes on a container with no violations", async () => {
    const container = containerFrom(
      '<main><h1>Hola</h1><p>Un párrafo cualquiera.</p></main>',
    );
    await expect(expectNoAxeViolations(container)).resolves.toBeUndefined();
  });

  it("lets a specific rule be disabled with a reason", async () => {
    const container = containerFrom('<img src="x.png">');
    await expect(
      expectNoAxeViolations(container, { disable: ["image-alt"] }),
    ).resolves.toBeUndefined();
  });
});
