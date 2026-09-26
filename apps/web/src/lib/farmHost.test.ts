import { describe, expect, it } from "vitest";
import {
  farmDevUrl,
  farmProdUrl,
  farmSlugFromHost,
  farmUrlForHere,
  isFarmHost,
  isFarmSlug,
  slugifyFarmName,
} from "./farmHost";

describe("farmSlugFromHost", () => {
  it("does not pin the apex, localhost, or loopback", () => {
    expect(farmSlugFromHost("bascula.engp.io")).toBeNull();
    expect(farmSlugFromHost("bascula.int.dev.engp.io")).toBeNull();
    expect(farmSlugFromHost("localhost")).toBeNull();
    expect(farmSlugFromHost("127.0.0.1")).toBeNull();
  });

  it("pins a farm label on prod and on internal dev", () => {
    expect(farmSlugFromHost("sanjose.bascula.engp.io")).toBe("sanjose");
    expect(farmSlugFromHost("sanjose.int.dev.engp.io")).toBe("sanjose");
    expect(farmSlugFromHost("la-esperanza.bascula.engp.io")).toBe("la-esperanza");
  });

  it("returns null for reserved labels, including www", () => {
    for (const label of [
      "www", "api", "admin", "mcp", "app", "int", "bascula", "static",
      "assets", "health", "oauth", "well-known", "mail", "staging", "prod", "dev",
    ]) {
      expect(farmSlugFromHost(`${label}.bascula.engp.io`)).toBeNull();
      expect(farmSlugFromHost(`${label}.int.dev.engp.io`)).toBeNull();
    }
  });

  it("ignores extra labels, unknown suffixes, and empty input", () => {
    expect(farmSlugFromHost("foo.sanjose.bascula.engp.io")).toBeNull();
    expect(farmSlugFromHost("sanjose.bascula.int.dev.engp.io")).toBeNull();
    expect(farmSlugFromHost("sanjose.example.com")).toBeNull();
    expect(farmSlugFromHost("")).toBeNull();
  });

  it("normalises case, a trailing dot, and a port", () => {
    expect(farmSlugFromHost("SANJOSE.BASCULA.ENGP.IO")).toBe("sanjose");
    expect(farmSlugFromHost("sanjose.bascula.engp.io.")).toBe("sanjose");
    expect(farmSlugFromHost("sanjose.bascula.engp.io:443")).toBe("sanjose");
  });
});

describe("isFarmSlug and slugifyFarmName", () => {
  it("accepts a DNS label that is not reserved", () => {
    expect(isFarmSlug("sanjose")).toBe(true);
    expect(isFarmSlug("la-esperanza")).toBe(true);
    expect(isFarmSlug("www")).toBe(false);
    expect(isFarmSlug("Admin")).toBe(false);
    expect(isFarmSlug("-nope")).toBe(false);
    expect(isFarmSlug("nope-")).toBe(false);
    expect(isFarmSlug("")).toBe(false);
  });

  it("turns a farm name into a label", () => {
    expect(slugifyFarmName("San José")).toBe("san-jose");
    expect(slugifyFarmName("La Esperanza")).toBe("la-esperanza");
    expect(slugifyFarmName("www")).toBe("finca");
    expect(slugifyFarmName("   ")).toBe("finca");
  });

  it("builds the two public URLs from a slug", () => {
    expect(farmProdUrl("sanjose")).toBe("https://sanjose.bascula.engp.io");
    expect(farmDevUrl("sanjose")).toBe("https://sanjose.int.dev.engp.io");
  });

  it("advertises the host that matches where we are standing", () => {
    expect(farmUrlForHere("fincasanjose", "bascula.int.dev.engp.io")).toBe(
      "https://fincasanjose.int.dev.engp.io",
    );
    expect(farmUrlForHere("fincasanjose", "bascula.engp.io")).toBe(
      "https://fincasanjose.bascula.engp.io",
    );
  });
});

describe("isFarmHost", () => {
  it("is true only on a farm's own address", () => {
    expect(isFarmHost("cafin3.bascula.engp.io")).toBe(true);
    expect(isFarmHost("cafin3.int.dev.engp.io")).toBe(true);
    expect(isFarmHost("bascula.engp.io")).toBe(false);
    expect(isFarmHost("bascula.int.dev.engp.io")).toBe(false);
    expect(isFarmHost("www.bascula.engp.io")).toBe(false);
    expect(isFarmHost("localhost")).toBe(false);
  });
});
