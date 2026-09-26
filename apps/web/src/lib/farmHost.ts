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

/**
 * The same rule the API enforces (services/api/internal/httpapi/slug.go):
 * 2–63 characters, lowercase letters and digits, single hyphens between them.
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slugShapeOk(value: string): boolean {
  return value.length >= 2 && value.length <= 63 && SLUG_RE.test(value);
}

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
  if (!label || RESERVED.has(label) || !slugShapeOk(label)) return null;
  return label;
}

export function isFarmSlug(value: string): boolean {
  return slugShapeOk(value) && !RESERVED.has(value);
}

export function isReservedFarmSlug(value: string): boolean {
  return RESERVED.has(value);
}

/**
 * What is wrong with a web address, in words a farm owner can act on, or null
 * when it is fine. Same rule as the API, so the form never promises an address
 * the server then refuses.
 */
export function farmSlugProblem(value: string): string | null {
  if (!value) return "Escriba la dirección web de la finca.";
  if (value.length < 2) return "La dirección debe tener al menos 2 letras.";
  if (value.length > 63) return "La dirección es muy larga. Use máximo 63 letras.";
  if (!SLUG_RE.test(value)) {
    return "Use solo letras minúsculas sin tildes, números y guiones. Ejemplo: lapalma";
  }
  if (RESERVED.has(value)) return "Esa dirección está reservada. Escriba otra.";
  return null;
}

/**
 * Keep what the owner types inside the rule while they type: lowercase, no
 * accents, spaces become hyphens, anything else is dropped.
 */
export function cleanFarmSlugInput(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63);
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

/** `lapalma.bascula.engp.io` — the address without the scheme, for previews. */
export function farmHostForHere(slug: string, hostname?: string): string {
  return farmUrlForHere(slug, hostname).replace(/^https:\/\//, "");
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

/**
 * True when this page is served on a farm's own address
 * (`{slug}.bascula.engp.io`, `{slug}.int.dev.engp.io`), where there is no
 * landing: `/` is the farm's app. The landing lives only on the main domain.
 */
export function isFarmHost(hostname?: string): boolean {
  const host = hostname ?? (typeof window !== "undefined" ? window.location.hostname : "");
  return farmSlugFromHost(host) !== null;
}

/**
 * The general demo: a main domain that shows the farm's front door at `/`
 * instead of the marketing landing. The production main domain keeps the
 * landing.
 */
const DEMO_HOSTS = new Set(["bascula.int.dev.engp.io"]);

/** `/` shows the entry page (Entrar / ¿Olvidó su clave?; Registrar on the demo only). */
export function showsFarmEntry(hostname?: string): boolean {
  const host = normalizeHostname(hostname ?? (typeof window !== "undefined" ? window.location.hostname : ""));
  return isFarmHost(host) || DEMO_HOSTS.has(host);
}

/**
 * Whether this address may offer to register a farm. Only a main domain
 * (bascula.engp.io, the dev demo, localhost) does. A farm's own address never
 * shows "Registrar" anywhere — not on its front door, not on its login, and
 * /empezar there goes back to the front door: each farm is isolated, and new
 * farms are created only at bascula.engp.io/empezar or in the super-admin
 * console. The API refuses POST /v1/farms from inside a farm as well.
 */
export function offersSignup(hostname?: string): boolean {
  return !isFarmHost(hostname);
}

/** Where the app starts: `/tablero` (the guard sends a visitor to `/entrar`). */
export const APP_HOME = "/tablero";

/**
 * How the front door names a farm: "Finca San José". A farm already called
 * "Finca La Palma" is not greeted as "Finca Finca La Palma".
 */
export function farmGreeting(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) return "";
  return /^finca(\s|$)/i.test(clean) ? clean : `Finca ${clean}`;
}
