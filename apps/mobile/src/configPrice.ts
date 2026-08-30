/**
 * What price the settings screen is allowed to write, and when it must refuse.
 *
 * `docs/auditorias.md` closes with the rule this file exists to hold on the
 * handset: **not knowing is not zero**, and «a pattern solved in one place does
 * not spread on its own». The harvest module solved it with a union that has no
 * numeric member for the unknown case; `balanceDisplay.ts` moved that shape onto
 * the phone for a balance somebody reads. This moves it onto the one price
 * somebody WRITES.
 *
 * The hole it closes: on a handset attached to a farm the price field is
 * read-only, because the week's price is the owner's and it arrives from the
 * server (Decision 6). Saving the rest of the configuration therefore had to
 * carry the price across untouched — and it did it with `Config.get()?.costPerUnit
 * ?? 0`. A phone that has not yet heard a price wrote **0**, which is not a
 * refusal and not an error: it is a whole farm's week of weighings valued at
 * nothing, computed and printed and paid out with no red anywhere.
 *
 * So the missing price is a state with no number on it. A screen that forgets
 * to handle the case cannot reach an amount to save; it fails to compile.
 *
 * React-free and SQLite-free on purpose, like `balanceDisplay.ts`: the rule is
 * arithmetic and is tested as arithmetic, not by rendering a screen.
 */

import type { CropConfig } from "./data/repository.ts";

export type PriceToSave =
  /**
   * The handset answers to a farm, the price is the server's, and there is a
   * stored one to carry across untouched. This is the ordinary case.
   */
  | { state: "stored"; costPerUnit: number }
  /**
   * The handset sets its own price and somebody typed a usable one.
   */
  | { state: "typed"; costPerUnit: number }
  /**
   * The handset answers to a farm and no price has arrived yet. Refuse the
   * save and say so. NO numeric member — there is nothing here to write by
   * accident.
   */
  | { state: "notYet" }
  /**
   * The handset sets its own price and the field does not hold one: empty,
   * not a number, negative, or zero. Refuse the save and say so.
   *
   * Zero counts as absent for the same reason `addOverride` has always
   * rejected it on the weekly price: nobody picks coffee for nothing, so a 0
   * in that box is a half-typed number or a cleared field, never an intention.
   */
  | { state: "invalid" };

/** A price is a price only if it is a finite number above zero. */
function usable(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * The typed field, the stored configuration and who owns the price → what to
 * write.
 *
 * `stored` is what `Config.get()` returned. Note that its `costPerUnit` is
 * typed `number` while the column behind it is a nullable REAL, so a row saved
 * before the price arrived hands back `null` through a type that says
 * otherwise. `usable` is checked against the value, not the type.
 */
export function priceToSave(
  typed: string,
  stored: CropConfig | null,
  priceIsReadOnly: boolean,
): PriceToSave {
  if (priceIsReadOnly) {
    const carried = stored?.costPerUnit;
    return usable(carried) ? { state: "stored", costPerUnit: carried } : { state: "notYet" };
  }
  const n = Number(typed.trim());
  return usable(n) ? { state: "typed", costPerUnit: n } : { state: "invalid" };
}

/** The two states that carry a number, and the two that refuse. */
export type PriceKnown = Extract<PriceToSave, { costPerUnit: number }>;
export type PriceRefused = Exclude<PriceToSave, PriceKnown>;

/**
 * The guard the screen has to pass before it can reach an amount at all.
 *
 * This is the part that makes the mistake impossible rather than merely
 * unlikely: on the other side of a `false` there is no `costPerUnit` in the
 * type, so no save can be written that stores one.
 */
export function priceIsKnown(p: PriceToSave): p is PriceKnown {
  return p.state === "stored" || p.state === "typed";
}

/**
 * The dictionary key for a refusal.
 *
 * Returns the KEY rather than a sentence, because the three dictionaries live
 * in `strings.ts` and this file has no `t` — the same division
 * `balanceAgeKey` uses. It takes only the refusing states, so there is no
 * "no message" case for a caller to mishandle.
 */
export function priceRefusalKey(p: PriceRefused): string {
  switch (p.state) {
    case "notYet":
      return "settings.priceNotYet";
    case "invalid":
      return "settings.priceInvalid";
  }
}
