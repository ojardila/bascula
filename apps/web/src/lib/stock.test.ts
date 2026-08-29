import { describe, expect, it } from "vitest";
import {
  exceedsStock, formatSignedQty, reasonNeedsDirection, signedQty, stockAfter,
} from "./stock";
import { STOCK_REASON_SIGN, type StockReason } from "../api/types";

/**
 * The `stock_sign` CHECK, from the migration, restated so a change to either
 * side breaks:
 *
 *   (reason IN ('cosecha','compra')        AND qty > 0)
 *   OR (reason IN ('venta','consumo','merma') AND qty < 0)
 *   OR (reason IN ('traslado','ajuste'))
 */
describe("the sign comes from the reason, not from the person typing", () => {
  it("makes cosecha and compra come in, whatever was typed", () => {
    expect(signedQty(320, "cosecha")).toBe(320);
    expect(signedQty(-320, "cosecha")).toBe(320);
    expect(signedQty(40, "compra")).toBe(40);
  });

  it("makes venta, consumo and merma go out, whatever was typed", () => {
    expect(signedQty(12, "venta")).toBe(-12);
    expect(signedQty(-12, "venta")).toBe(-12);
    expect(signedQty(3, "consumo")).toBe(-3);
    expect(signedQty(1.5, "merma")).toBe(-1.5);
  });

  it("asks which way only for the two reasons the database leaves free", () => {
    const free = (Object.keys(STOCK_REASON_SIGN) as StockReason[]).filter(reasonNeedsDirection);
    expect(free.sort()).toEqual(["ajuste", "traslado"]);
    expect(signedQty(5, "traslado", "out")).toBe(-5);
    expect(signedQty(5, "traslado", "in")).toBe(5);
    expect(signedQty(5, "ajuste", "out")).toBe(-5);
  });

  it("never produces a sign the CHECK would refuse", () => {
    for (const reason of Object.keys(STOCK_REASON_SIGN) as StockReason[]) {
      for (const direction of ["in", "out"] as const) {
        const q = signedQty(7, reason, direction);
        const rule = STOCK_REASON_SIGN[reason];
        if (rule === "in") expect(q).toBeGreaterThan(0);
        if (rule === "out") expect(q).toBeLessThan(0);
        expect(q).not.toBe(0);
      }
    }
  });
});

describe("showing a movement", () => {
  it("uses a real minus sign and the storage unit", () => {
    expect(formatSignedQty(-12, "Bulto")).toBe("− 12 Bulto");
    expect(formatSignedQty(320, "Kilo")).toBe("+ 320 Kilo");
    expect(formatSignedQty(2.5)).toBe("+ 2,5");
  });
});

describe("what the warehouse would hold afterwards", () => {
  it("adds the signed quantity, rounded to the column's precision", () => {
    expect(stockAfter(20, -12)).toBe(8);
    // numeric(14,3): a preview that said 7,699999999999999 would be
    // arithmetically closer and visibly wrong.
    expect(stockAfter(20.1, -12.4)).toBe(7.7);
  });

  it("does not pretend the result cannot go negative", () => {
    // It can, and the server allows it with allowNegativeStock. Hiding that
    // here would make the preview disagree with what gets recorded.
    expect(stockAfter(2, -5)).toBe(-3);
  });
});

describe("asking before the server has to refuse", () => {
  it("is the same comparison the 409 makes", () => {
    expect(exceedsStock(20, 21)).toBe(true);
    expect(exceedsStock(20, 20)).toBe(false);
    expect(exceedsStock(0, 0.001)).toBe(true);
  });
});
