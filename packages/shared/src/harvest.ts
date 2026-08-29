/**
 * Reading the shape of a harvest. Pure on purpose: it takes the weekly totals
 * and returns what the farm should do about them, which is the part worth
 * testing and the part a chart cannot say out loud.
 */

export interface WeekTotal {
  week: string; // Monday, YYYY-MM-DD
  kg: number;
}

export interface HarvestShape {
  /** Week with the highest yield so far. */
  peak: WeekTotal | null;
  /** Consecutive finished weeks falling more than the threshold. */
  fallingWeeks: number;
  /** True when the harvest is clearly on its way out. */
  windingDown: boolean;
}

/**
 * `weeks` newest-first, as the queries return them. The current week is
 * excluded from the reading: it is still running, so its total will always
 * look like a fall next to a finished one.
 */
export function readHarvest(
  weeks: WeekTotal[],
  currentMonday: string,
  dropThreshold = 0.25,
): HarvestShape {
  const finished = weeks.filter((w) => w.week < currentMonday);
  if (!finished.length) {
    return { peak: null, fallingWeeks: 0, windingDown: false };
  }

  const peak = finished.reduce((best, w) => (!best || w.kg > best.kg ? w : best), finished[0]);

  // Newest first, so each week is compared against the one before it.
  let fallingWeeks = 0;
  for (let i = 0; i < finished.length - 1; i++) {
    const prev = finished[i + 1].kg;
    if (prev <= 0) break;
    const drop = (prev - finished[i].kg) / prev;
    if (drop > dropThreshold) fallingWeeks++;
    else break;
  }

  // Two falling weeks alone could be rain. Past the peak as well, it is the
  // season ending — which is when moving people to another plot pays off.
  return { peak, fallingWeeks, windingDown: fallingWeeks >= 2 && peak.week < currentMonday };
}
