import { describe, expect, it } from "vitest";
import { whatsappNumber, whatsappUrl } from "./share";

describe("whatsapp links", () => {
  it("adds Colombia's 57 to a ten-digit mobile", () => {
    expect(whatsappNumber("300 123 4567")).toBe("573001234567");
    expect(whatsappNumber("+57 300 123 4567")).toBe("573001234567");
  });

  it("drops numbers too short to be a chat", () => {
    expect(whatsappNumber("12345")).toBeNull();
    expect(whatsappNumber(null)).toBeNull();
  });

  it("encodes the text", () => {
    expect(whatsappUrl("Pagado: $10.000", "3001234567")).toBe(
      "https://wa.me/573001234567?text=Pagado%3A%20%2410.000",
    );
    expect(whatsappUrl("hola")).toBe("https://wa.me/?text=hola");
  });
});
