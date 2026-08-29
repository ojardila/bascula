/**
 * Which API is this build talking to, and does anybody know?
 *
 * Sprint 1 shipped with `VITE_USE_MOCKS=true` in `.env.development` and no
 * indication anywhere in the interface that the coffee farm on screen was
 * invented. That is fine for a week and dangerous for a month: the failure it
 * eventually produces is somebody demonstrating "the app" to a farmer using
 * data that will vanish on reload, or — worse — reporting a bug against the
 * mock's behaviour and sending the API pair looking for it in Go.
 *
 * So the choice is now explicit in three places at once:
 *
 *   1. It is a single flag, `VITE_USE_MOCKS`, with no clever fallback. If it
 *      is not exactly the string "true", the app talks to the server. There is
 *      no "mocks if the server seems down", because a mode that can change by
 *      itself is a mode nobody can reason about at four in the afternoon.
 *   2. It is printed to the console at boot, once, with the base URL.
 *   3. It is on the screen: `<ApiModeBadge>` sits in the shell in mock mode and
 *      says so in Spanish. It is deliberately not dismissible.
 *
 * The contradictory combination — mocks on AND a real server configured — is
 * warned about rather than silently resolved, because it is nearly always
 * somebody who edited one line of `.env.development` and expected the other to
 * follow.
 */

/** True only for the exact string. Anything else means the real API. */
export const USE_MOCKS: boolean = import.meta.env.VITE_USE_MOCKS === "true";

/**
 * The prefix every request gets. Empty by default and it should stay empty:
 * the Vite dev server proxies `/v1` and `/health` to `VITE_API_URL`, which is
 * what keeps the browser from needing CORS the API does not implement. Set
 * this only if you are pointing at a server that does send CORS headers.
 */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "";

/**
 * Where the dev-server proxy sends `/v1`. The app itself never fetches this
 * origin directly — `vite.config.ts` reads it — but it is worth showing in the
 * boot line so "which server am I hitting" is answerable without opening a
 * config file.
 */
export const API_ORIGIN: string = import.meta.env.VITE_API_URL ?? "http://localhost:8099";

export interface ApiMode {
  mocks: boolean;
  /** What to show a human: "datos simulados" or the server it is talking to. */
  label: string;
  target: string;
}

export function apiMode(): ApiMode {
  return USE_MOCKS
    ? { mocks: true, label: "Datos simulados", target: "MSW (en el navegador)" }
    : {
        mocks: false,
        label: "API real",
        target: API_BASE_URL || `${API_ORIGIN} (vía proxy de Vite)`,
      };
}

/**
 * Announce the mode once, at boot. Called from `main.tsx` before React renders
 * so it is the first thing in the console, above whatever the app logs later.
 */
export function announceApiMode(): void {
  const mode = apiMode();
  const style = mode.mocks
    ? "background:#8a6d00;color:#fff;padding:2px 6px;border-radius:3px"
    : "background:#1b5e20;color:#fff;padding:2px 6px;border-radius:3px";

  console.info(`%cBáscula · ${mode.label}%c → ${mode.target}`, style, "");

  if (USE_MOCKS && import.meta.env.VITE_API_URL) {
    console.warn(
      "Báscula: VITE_USE_MOCKS=true gana sobre VITE_API_URL. " +
        "Las peticiones NO llegan al servidor. Ponga VITE_USE_MOCKS=false para usar la API real.",
    );
  }
}
