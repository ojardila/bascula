// SPDX-License-Identifier: MIT
/**
 * A short Spanish name for the browser and device behind a User-Agent, for
 * «Sesiones abiertas»: "Chrome en Android", "Safari en iPhone". It only has to
 * help a person recognise their own phone, so it knows the common cases and
 * says "Dispositivo desconocido" for the rest rather than guessing.
 */

const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/CriOS\/|Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/CrOS/, "Chromebook"],
  [/Windows/, "Windows"],
  [/Macintosh|Mac OS X/, "Mac"],
  [/Linux/, "Linux"],
];

function first(table: [RegExp, string][], ua: string): string | null {
  for (const [re, name] of table) if (re.test(ua)) return name;
  return null;
}

export function deviceLabel(ua: string): string {
  const browser = first(BROWSERS, ua);
  const system = first(SYSTEMS, ua);
  if (browser && system) return `${browser} en ${system}`;
  return browser ?? system ?? "Dispositivo desconocido";
}

/** True when the User-Agent looks like a phone or a tablet. */
export function isMobileAgent(ua: string): boolean {
  return /iPhone|iPad|Android|Mobile/.test(ua);
}
