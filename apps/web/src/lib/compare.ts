// SPDX-License-Identifier: MIT
/**
 * Plain ascending order for strings that sort by code unit, like ISO days
 * and instants: "2026-08-29" < "2026-09-01". Not for names — those want
 * `localeCompare("es")`.
 */
export function compareAsc(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
