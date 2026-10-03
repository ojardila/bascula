/**
 * The same shape check the forms used to do with
 * `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`: no whitespace, exactly one `@` with
 * something before it, and a dot in the domain with something on both sides.
 * Done without that regex so a long hostile string cannot make it backtrack.
 */
export function looksLikeEmail(raw: string): boolean {
  if (/\s/.test(raw)) return false;
  const parts = raw.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local) return false;
  // A dot that is neither the first nor the last character of the domain.
  return domain.slice(1, -1).includes(".");
}
