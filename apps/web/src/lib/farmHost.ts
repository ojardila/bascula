/**
 * The farm the browser is on, read off the hostname.
 *
 * Prod and dev share one console. The apex (`bascula.engp.io`,
 * `bascula.int.dev.engp.io`) is the unpinned door: login may still ask which
 * farm. `{slug}.bascula.engp.io` and `{slug}.int.dev.engp.io` pin it. The
 * tenant still travels in the JWT; the host is only how the server knows
 * which farm the password is being offered to.
 *
 * Labels that would collide with the platform itself are not farms.
 */

const RESERVED = new Set([
  "www",
  "api",
  "admin",
  "mcp",
  "app",
  "int",
  "bascula",
  "static",
  "assets",
  "health",
  "oauth",
  "well-known",
  "mail",
  "staging",
  "prod",
  "dev",
]);

const APEX = new Set([
  "bascula.engp.io",
  "bascula.int.dev.engp.io",
  "localhost",
  "127.0.0.1",
]);

const PROD_SUFFIX = ".bascula.engp.io";
const DEV_SUFFIX = ".int.dev.engp.io";

/** DNS-label shape: 1–63 chars, lowercase letters, digits, interior hyphens. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "").split(":")[0] ?? "";
}

/**
 * The farm slug this host pins, or null when it does not pin one.
 *
 *   bascula.engp.io                 → null
 *   sanjose.bascula.engp.io         → "sanjose"
 *   sanjose.int.dev.engp.io         → "sanjose"
 *   www.bascula.engp.io             → null  (reserved)
 */
export function farmSlugFromHost(hostname: string): string | null {
  const host = normalizeHostname(hostname);
  if (!host || APEX.has(host)) return null;

  let label: string | null = null;
  if (host.endsWith(PROD_SUFFIX)) {
    const rest = host.slice(0, -PROD_SUFFIX.length);
    if (rest && !rest.includes(".")) label = rest;
  } else if (host.endsWith(DEV_SUFFIX)) {
    const rest = host.slice(0, -DEV_SUFFIX.length);
    if (rest && !rest.includes(".")) label = rest;
  }
  if (!label || RESERVED.has(label) || !SLUG_RE.test(label)) return null;
  return label;
}

export function isFarmSlug(value: string): boolean {
  return SLUG_RE.test(value) && !RESERVED.has(value);
}

/** `San José` → `san-jose`. Empty or reserved names fall back to `finca`. */
export function slugifyFarmName(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  if (!slug || RESERVED.has(slug)) return "finca";
  return slug;
}

export function farmProdUrl(slug: string): string {
  return `https://${slug}${PROD_SUFFIX}`;
}

export function farmDevUrl(slug: string): string {
  return `https://${slug}${DEV_SUFFIX}`;
}

/** The URL this browser should advertise for a new farm. */
export function farmUrlForHere(slug: string, hostname?: string): string {
  const host = hostname ?? (typeof window !== "undefined" ? window.location.hostname : "");
  if (
    host.endsWith("int.dev.engp.io") ||
    host === "localhost" ||
    host === "127.0.0.1"
  ) {
    return farmDevUrl(slug);
  }
  return farmProdUrl(slug);
}
