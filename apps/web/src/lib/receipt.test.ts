/**
 * El recibo de pago iba encabezado por un UUID de 36 caracteres, que es
 * exactamente el número que el dueño leería por teléfono si alguien reclama.
 */
import { describe, expect, it } from "vitest";
import { shortReceiptNumber } from "./receipt";

describe("el número que se dicta por teléfono", () => {
  it("son ocho dígitos en dos bloques", () => {
    expect(shortReceiptNumber("0192f3a0-0009-7000-8000-0000000000ab")).toBe("0000-00AB");
    expect(shortReceiptNumber("0192f3a0-0009-7000-8000-00000000ab3f")).toBe("0000-AB3F");
  });

  /**
   * Los UUIDv7 comparten prefijo —van ordenados por tiempo— y no cola. Coger
   * los últimos dígitos es coger la parte aleatoria, que es la que distingue
   * dos pagos de la misma tarde.
   */
  it("distingue dos pagos seguidos, que comparten prefijo", () => {
    const a = shortReceiptNumber("0192f3a0-0009-7000-8000-00000000aaaa");
    const b = shortReceiptNumber("0192f3a0-0009-7000-8000-00000000bbbb");
    expect(a).not.toBe(b);
  });

  it("es el mismo número cada vez que se pide", () => {
    const id = "0192f3a0-0009-7000-8000-00000000ab3f";
    expect(shortReceiptNumber(id)).toBe(shortReceiptNumber(id));
  });

  /** Si alguna vez llega algo que no es un uuid, se enseña tal cual. */
  it("no se rompe con algo que no es un uuid", () => {
    expect(shortReceiptNumber("abc")).toBe("ABC");
    expect(shortReceiptNumber("")).toBe("");
  });
});
