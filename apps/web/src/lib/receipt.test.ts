/**
 * The payment receipt was headed by a 36-character UUID, which is exactly the
 * number the owner would read out over the phone if somebody disputes it.
 */
import { describe, expect, it } from "vitest";
import { shortReceiptNumber } from "./receipt";

describe("the number that gets dictated over the phone", () => {
  it("is eight digits in two blocks", () => {
    expect(shortReceiptNumber("0192f3a0-0009-7000-8000-0000000000ab")).toBe("0000-00AB");
    expect(shortReceiptNumber("0192f3a0-0009-7000-8000-00000000ab3f")).toBe("0000-AB3F");
  });

  /**
   * UUIDv7s share a prefix —they are ordered by time— and not a tail. Taking
   * the last digits is taking the random part, which is what tells two
   * payments from the same afternoon apart.
   */
  it("tells apart two back-to-back payments, which share a prefix", () => {
    const a = shortReceiptNumber("0192f3a0-0009-7000-8000-00000000aaaa");
    const b = shortReceiptNumber("0192f3a0-0009-7000-8000-00000000bbbb");
    expect(a).not.toBe(b);
  });

  it("is the same number every time it is asked for", () => {
    const id = "0192f3a0-0009-7000-8000-00000000ab3f";
    expect(shortReceiptNumber(id)).toBe(shortReceiptNumber(id));
  });

  /** If something that is not a uuid ever arrives, it is shown as it is. */
  it("does not break on something that is not a uuid", () => {
    expect(shortReceiptNumber("abc")).toBe("ABC");
    expect(shortReceiptNumber("")).toBe("");
  });
});
