// SPDX-License-Identifier: MIT
/**
 * Where to go after signing in: the page the person was headed to, when it is
 * a page of this app.
 *
 * `from` arrives in router state (the guard puts `location.pathname` there),
 * but router state is just data and anything could have pushed it, so it is
 * checked before it is followed: only a same-origin path that starts with a
 * single "/" is accepted. Absolute URLs ("https://…"), protocol-relative
 * ones ("//evil.example"), backslash tricks ("/\\evil.example"), other
 * schemes ("javascript:…") and control characters are refused. The front door
 * "/" and the login page itself are refused too: they would only bounce. In
 * every refused case the caller falls back to the role's home.
 */
const BASE = "https://app.invalid";

export function safeReturnPath(from: unknown): string | null {
  if (typeof from !== "string") return null;
  if (!from.startsWith("/") || from.startsWith("//")) return null;
  // Browsers read "\" as "/" in URLs, and strip tabs and newlines.
  if (from.includes("\\")) return null;
  for (const ch of from) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  let url: URL;
  try {
    url = new URL(from, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  if (url.pathname === "/" || url.pathname === "/entrar") return null;
  return url.pathname + url.search + url.hash;
}
