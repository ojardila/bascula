import { describe, expect, it } from "vitest";
import {
  farmGreeting,
  farmDevUrl,
  farmProdUrl,
  farmSlugFromHost,
  farmUrlForHere,
  isFarmHost,
  isFarmSlug,
  showsFarmEntry,
  offersSignup,
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
    expect(farmUrlForHere("lapalma", "bascula.int.dev.engp.io")).toBe(
      "https://lapalma.int.dev.engp.io",
    );
    expect(farmUrlForHere("lapalma", "bascula.engp.io")).toBe(
      "https://lapalma.bascula.engp.io",
    );
    expect(farmUrlForHere("lapalma", "sanjose.int.dev.engp.io")).toBe(
      "https://lapalma.int.dev.engp.io",
    );
    expect(farmUrlForHere("lapalma", "localhost")).toBe("https://lapalma.int.dev.engp.io");
    expect(farmUrlForHere("lapalma", "127.0.0.1")).toBe("https://lapalma.int.dev.engp.io");
    expect(farmUrlForHere("lapalma", "BASCULA.INT.DEV.ENGP.IO.")).toBe(
      "https://lapalma.int.dev.engp.io",
    );
  });

  it("does not take a look-alike host for dev", () => {
    for (const host of [
      "evil.com?.int.dev.engp.io",
      "evil.com/.int.dev.engp.io",
      "evil.com#.int.dev.engp.io",
      "xint.dev.engp.io",
      "int.dev.engp.io.evil.com",
      "a.b.int.dev.engp.io",
      "localhost.evil.com",
    ]) {
      expect(farmUrlForHere("lapalma", host)).toBe("https://lapalma.bascula.engp.io");
    }
  });
});

describe("look-alike hosts", () => {
  it("never pins a farm on a host that only contains a Báscula suffix", () => {
    for (const host of [
      "evil.com?.bascula.engp.io",
      "evil.com/.bascula.engp.io",
      "evil.com#.bascula.engp.io",
      "bascula.engp.io.evil.com",
      "sanjose.bascula.engp.io.evil.com",
      "sanjosebascula.engp.io",
      "evil.com?.int.dev.engp.io",
      "sanjose.int.dev.engp.io.evil.com",
    ]) {
      expect(farmSlugFromHost(host)).toBeNull();
      expect(isFarmHost(host)).toBe(false);
    }
  });
});

describe("isFarmHost", () => {
  it("is true only on a farm's own address", () => {
    expect(isFarmHost("lapalma.bascula.engp.io")).toBe(true);
    expect(isFarmHost("lapalma.int.dev.engp.io")).toBe(true);
    expect(isFarmHost("bascula.engp.io")).toBe(false);
    expect(isFarmHost("bascula.int.dev.engp.io")).toBe(false);
    expect(isFarmHost("www.bascula.engp.io")).toBe(false);
    expect(isFarmHost("localhost")).toBe(false);
  });
});

describe("showsFarmEntry", () => {
  it("is the farm hosts and the demo, never the production main domain", () => {
    expect(showsFarmEntry("lapalma.bascula.engp.io")).toBe(true);
    expect(showsFarmEntry("bascula.int.dev.engp.io")).toBe(true);
    expect(showsFarmEntry("bascula.engp.io")).toBe(false);
    expect(showsFarmEntry("localhost")).toBe(false);
  });
  it("offers to register a farm on main domains only, never on a farm", () => {
    expect(offersSignup("lapalma.bascula.engp.io")).toBe(false);
    expect(offersSignup("lapalma.int.dev.engp.io")).toBe(false);
    expect(offersSignup("bascula.int.dev.engp.io")).toBe(true);
    expect(offersSignup("bascula.engp.io")).toBe(true);
    expect(offersSignup("localhost")).toBe(true);
  });
});

describe("farmGreeting", () => {
  it("puts «Finca» before the name", () => {
    expect(farmGreeting("San José")).toBe("Finca San José");
    expect(farmGreeting("  La   Palma ")).toBe("Finca La Palma");
  });

  it("does not say «Finca Finca» when the name already starts with it", () => {
    expect(farmGreeting("Finca La Palma")).toBe("Finca La Palma");
    expect(farmGreeting("finca el mirador")).toBe("finca el mirador");
    expect(farmGreeting("FINCA")).toBe("FINCA");
  });

  it("keeps names that merely begin with the same letters", () => {
    expect(farmGreeting("Fincas Unidas")).toBe("Finca Fincas Unidas");
  });
});
