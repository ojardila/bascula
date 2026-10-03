// SPDX-License-Identifier: MIT
/**
 * `s` without any run of `ch` at its end: `trimTrailing("/cosecha//", "/")`
 * → `"/cosecha"`. A plain loop instead of `/\/+$/`, which backtracks
 * quadratically on a long string of the character that is not at the end.
 */
export function trimTrailing(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}
