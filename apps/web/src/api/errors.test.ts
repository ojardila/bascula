/**
 * EIGHT CODES WERE REACHING THE SCREEN IN ENGLISH.
 *
 * One of them was `LAST_OWNER`: what an owner sees when they try to take
 * themselves off the farm. In the middle of a Spanish console, an uppercase
 * code and an English sentence do not say "this cannot be done"; they say
 * "you broke something", which is exactly what this product cannot afford to
 * say to somebody who already assumes the fault is theirs.
 *
 * Translating them by hand was half the fix. This is the other half: the
 * table is checked against the contract, so the day the API grows a code —and
 * it does every sprint— the test names it instead of letting it reach the
 * screen in English until somebody trips over it.
 *
 * `schema.ts` is read with `fs` rather than importing the type because
 * `ErrorCode` is a type and not a value: it does not exist at runtime, and a
 * test that only checks types does not fail, it stops compiling somewhere
 * else.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ERROR_MESSAGES, ApiError, messageFor } from "./errors";

function contractCodes(): string[] {
  // From the project root: under jsdom `import.meta.url` is an http URL and
  // `fileURLToPath` refuses it.
  const schema = readFileSync(resolve(process.cwd(), "src/api/schema.ts"), "utf8");
  const line = schema.match(/ErrorCode: ((?:"[A-Z_]+" \| )*"[A-Z_]+");/);
  if (!line) throw new Error("ErrorCode not found in schema.ts");
  return line[1].split(" | ").map((s) => s.replace(/"/g, ""));
}

describe("the message table against the contract", () => {
  it("has a Spanish sentence for every code the API can send", () => {
    const missing = contractCodes().filter((c) => !(c in ERROR_MESSAGES));
    expect(missing).toEqual([]);
  });

  it("and none of those sentences is empty", () => {
    for (const code of contractCodes()) {
      expect(ERROR_MESSAGES[code].trim().length).toBeGreaterThan(10);
    }
  });

  /**
   * The one the reviewer named: an owner taking themselves off the farm. And
   * the sentence says what to do, not only what happened — name another owner
   * first.
   */
  it("the owner who removes themselves reads Spanish, and reads what to do", () => {
    const e = new ApiError(409, {
      error: { code: "LAST_OWNER", message: "farm would be left with no owner" },
    });
    expect(messageFor(e)).toContain("sin dueño");
    expect(messageFor(e)).toContain("otro dueño");
    expect(messageFor(e)).not.toContain("owner");
  });

  /** With no translation, the server's text is shown rather than swallowed. */
  it("an unknown code shows what the server said, not a mute screen", () => {
    const e = new ApiError(409, {
      error: { code: "SOMETHING_NEW", message: "algo pasó" },
    });
    expect(messageFor(e)).toBe("algo pasó");
  });
});
