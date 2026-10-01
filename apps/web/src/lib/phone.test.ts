import { describe, expect, it } from "vitest";
import { checkContactPhone } from "./phone";

const ok = (raw: string) => {
  const r = checkContactPhone(raw);
  return r.ok ? r.e164 : r.reason;
};

describe("checkContactPhone", () => {
  it("accepts Colombian mobiles however they are written", () => {
    for (const raw of ["3104827391", "310 482 7391", "310-482-7391", "(310) 482 7391", "+57 310 482 7391", "+573104827391", "0057 310 482 7391", "57 310 482 7391"]) {
      expect(ok(raw), raw).toBe("+573104827391");
    }
  });

  it("accepts Colombian landlines with the 60X prefix", () => {
    expect(ok("601 742 3856")).toBe("+576017423856");
    expect(ok("+57 604 742 3856")).toBe("+576047423856");
  });

  it("formats for the person who calls back", () => {
    const r = checkContactPhone("3104827391");
    expect(r.ok && r.display).toBe("+57 310 482 7391");
  });

  it("refuses what is not a Colombian number", () => {
    for (const raw of ["1234567", "7423856", "310482739", "31048273912", "2104827391", "3604827391", "609 742 3856", "123456789012"]) {
      expect(ok(raw), raw).toBe("colombia");
    }
  });

  it("refuses letters and stray symbols", () => {
    for (const raw of ["abc3104827391", "310 482 7391 ext 2", "310+4827391", "++573104827391", "310/482/7391"]) {
      expect(ok(raw), raw).toBe("characters");
    }
  });

  it("refuses filler", () => {
    for (const raw of ["3000000000", "311 111 1111", "300 123 4567", "310 765 4321", "+1 305 000 0000"]) {
      expect(ok(raw), raw).toBe("filler");
    }
  });

  it("accepts international numbers written with + and a country code", () => {
    expect(ok("+1 305 482 7391")).toBe("+13054827391");
    expect(ok("+34 612 48 27 39")).toBe("+34612482739");
    expect(ok("0034 612 482 739")).toBe("+34612482739");
  });

  it("refuses international numbers that cannot exist", () => {
    for (const raw of ["+0 305 482 7391", "+1 305", "+1234567890123456"]) {
      expect(ok(raw), raw).toBe("international");
    }
  });

  it("says empty when there is nothing", () => {
    expect(ok("   ")).toBe("empty");
  });
});
