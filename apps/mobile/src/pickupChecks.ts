/**
 * The two decisions the weighing screen makes that are not about pixels, kept
 * out of the component so they can be tested without a phone.
 *
 * Both exist for the same person: Wilson, at four in the afternoon, with
 * gloves on and twenty people in the queue. One shortens the list he has to
 * read; the other is the last chance to catch the zero he typed twice, while
 * the picker is still standing in front of him and before the number becomes
 * money.
 */

/**
 * Lowercase, unaccented, punctuation-free. So «Ramirez» finds «Ramírez» and a
 * card typed as «t-1» finds «T1» — a search box that demands the accent is a
 * search box that is faster to give up on than to use.
 */
export function foldText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Something that can be found by what it is called or by the card it carries. */
export interface Findable {
  label: string;
  tag?: string;
}

/**
 * Whether this row answers to what was typed.
 *
 * The card number is matched from the START and the name ANYWHERE: a card is
 * read off a piece of plastic and typed whole, while a name arrives as
 * whichever half the pesador remembers — «ramirez» has to find «Ana Ramírez».
 */
export function matches(item: Findable, query: string): boolean {
  const q = foldText(query);
  if (!q) return true;
  if (foldText(item.label).includes(q)) return true;
  const tag = foldText(item.tag ?? "");
  return !!tag && tag.startsWith(q);
}

/**
 * The card, exactly — not a prefix of it.
 *
 * When what was typed IS somebody's card, the whole choosing step is skipped
 * and they are selected outright. It has to be an exact match: selecting on a
 * prefix would jump to the wrong picker halfway through typing, and a screen
 * that changes who is being weighed while somebody is still typing is worse
 * than one that makes them tap.
 */
export function exactTag<T extends Findable>(items: readonly T[], query: string): T | null {
  const q = foldText(query);
  if (!q) return null;
  const hits = items.filter((i) => !!i.tag && foldText(i.tag) === q);
  // Two people carrying one card is a real state of the world (`PeopleAdd`
  // only WARNS about a duplicate), and picking one of them at random would put
  // the load on a coin toss. Ambiguity is handed back to the person.
  return hits.length === 1 ? hits[0] : null;
}

/**
 * More than one person carries a load of this weight, in this crop, ever.
 *
 * The same threshold the `impossible` review rule uses, and configurable for
 * the same reason: a bunch of plátano really does weigh more than a day of
 * coffee, so it is a suspicion and never a refusal.
 */
export const MAX_PLAUSIBLE_WEIGHT = 120;

/** How many of this person's own loads are needed before "usual" means anything. */
export const MIN_SAMPLES = 3;

/** How many times their usual load a weighing has to be before it is queried. */
export const DIGIT_FACTOR = 3;

export type WeightDoubt =
  | { rule: "impossible"; reference: number }
  | { rule: "digit"; reference: number };

/**
 * Whether to ask before writing this weight down.
 *
 * The two rules that catch 850 typed for 85, hoisted from the review screen —
 * which lives two screens away under Reportes → Rendimiento, and therefore
 * catches the mistake on Saturday when the money is already counted out.
 *
 * It ASKS. It never refuses: `requireWeight` in the data layer deliberately
 * has no upper bound, and a screen that blocked what the review screen is
 * designed to raise a question about would lose real work.
 */
export function weightDoubt(
  weight: number,
  typical: { avgWeight: number; samples: number },
  maxWeight: number = MAX_PLAUSIBLE_WEIGHT,
): WeightDoubt | null {
  if (!Number.isFinite(weight) || weight <= 0) return null;
  // The personal rule first when both fire: «lo normal de Ana es 78» tells
  // somebody what to type instead, and «nadie carga tanto» does not.
  if (
    typical.samples >= MIN_SAMPLES &&
    typical.avgWeight > 0 &&
    weight >= DIGIT_FACTOR * typical.avgWeight
  )
    return { rule: "digit", reference: Math.round(typical.avgWeight) };
  if (maxWeight > 0 && weight > maxWeight)
    return { rule: "impossible", reference: maxWeight };
  return null;
}
