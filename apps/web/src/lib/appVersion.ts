/**
 * Which build of the web app this page is running, and which one the server
 * has now.
 *
 * The build stamps its release (v0.2.37, …) into the bundle as
 * __APP_VERSION__ and writes the same value to /version.json next to it. A page
 * whose bundle says one thing while /version.json says another is running an
 * old copy (a phone that kept the app open, or a service worker that has
 * not swapped yet), and can say so instead of silently misbehaving.
 */
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" && __APP_VERSION__ ? __APP_VERSION__ : "dev";

/**
 * The version the server is serving right now, or null when it cannot be
 * asked. The query string and no-store go around every cache on the way
 * (the browser's, the service worker's, Cloudflare's): this answer is only
 * worth anything if it is fresh.
 */
export async function fetchServerVersion(): Promise<string | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version ? body.version : null;
  } catch {
    return null;
  }
}

/** True when the server has a different, real build than this page. */
export function isOutdated(local: string, server: string | null): boolean {
  return local !== "dev" && server !== null && server !== "dev" && server !== local;
}

/**
 * Move this page onto the newest build. Ask the service worker to fetch the
 * new version, let a waiting one take over, and reload once it controls the
 * page (or after a few seconds regardless). If the page is somehow still old
 * after that reload, the second attempt drops the worker and its caches so
 * the next load comes straight from the network.
 */
export async function applyUpdate(): Promise<void> {
  const KEY = "bascula.updateAttempts";
  const attempts = Number(sessionStorage.getItem(KEY) ?? "0");
  sessionStorage.setItem(KEY, String(attempts + 1));
  try {
    const sw = navigator.serviceWorker;
    if (sw) {
      if (attempts >= 1) {
        for (const reg of await sw.getRegistrations()) await reg.unregister();
        if ("caches" in window) {
          for (const k of await caches.keys()) await caches.delete(k);
        }
      } else {
        const reg = await sw.getRegistration();
        if (reg) {
          await reg.update().catch(() => undefined);
          const next = reg.waiting ?? reg.installing;
          if (next) {
            next.postMessage({ type: "SKIP_WAITING" });
            await new Promise<void>((resolve) => {
              const done = () => resolve();
              sw.addEventListener("controllerchange", done, { once: true });
              window.setTimeout(done, 4000);
            });
          }
        }
      }
    }
  } catch {
    // Whatever went wrong, the reload below is still the best next step.
  }
  window.location.reload();
}

/** Called once the page runs the newest build: forget earlier attempts. */
export function clearUpdateAttempts(): void {
  try {
    sessionStorage.removeItem("bascula.updateAttempts");
  } catch {
    /* private mode */
  }
}
