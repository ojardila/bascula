// SPDX-License-Identifier: MIT
/**
 * Which build of the web app this page is running, and which one the server
 * has now.
 *
 * The bundle carries its BUILD: a key of the web's own sources (apps/web,
 * packages/shared, the lockfile, openapi.yaml), stamped in as __APP_BUILD__.
 * The same image is promoted from release to release while those sources do
 * not change, so the build says "same code" and the release number does not.
 *
 * The RELEASE (v0.2.39, …) is not in the bundle at all. nginx answers
 * /version.json from the pod's environment, {"version": release, "build":
 * build}, and CD stamps the release into manifests/base/web.yaml. A page
 * whose build differs from the server's is running an old copy (a phone that
 * kept the app open, or a service worker that has not swapped yet), and can
 * say so instead of silently misbehaving. A release that only changed the
 * API does not nag anybody to reload an identical page.
 */
declare const __APP_BUILD__: string | undefined;

export const APP_BUILD: string =
  typeof __APP_BUILD__ === "string" && __APP_BUILD__ ? __APP_BUILD__ : "dev";

export interface ServerVersion {
  /** The release, vX.Y.Z (or "dev"). */
  version: string;
  /** The web build the server is serving, or null for an image older than builds. */
  build: string | null;
}

/**
 * What the server is serving right now, or null when it cannot be asked.
 * The query string and no-store go around every cache on the way (the
 * browser's, the service worker's, Cloudflare's): this answer is only worth
 * anything if it is fresh.
 */
export async function fetchServerVersion(): Promise<ServerVersion | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown; build?: unknown };
    if (typeof body.version !== "string" || !body.version) return null;
    const build = typeof body.build === "string" && body.build ? body.build : null;
    return { version: body.version, build };
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
/** Second attempt: no service worker, no caches; the reload hits the network. */
async function dropWorkerAndCaches(sw: ServiceWorkerContainer): Promise<void> {
  for (const reg of await sw.getRegistrations()) await reg.unregister();
  if ("caches" in window) {
    for (const k of await caches.keys()) await caches.delete(k);
  }
}

/** First attempt: fetch the new worker and wait (up to 4 s) for it to take over. */
async function switchToNewestWorker(sw: ServiceWorkerContainer): Promise<void> {
  const reg = await sw.getRegistration();
  if (!reg) return;
  await reg.update().catch(() => undefined);
  const next = reg.waiting ?? reg.installing;
  if (!next) return;
  next.postMessage({ type: "SKIP_WAITING" });
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    sw.addEventListener("controllerchange", done, { once: true });
    window.setTimeout(done, 4000);
  });
}

export async function applyUpdate(): Promise<void> {
  const KEY = "bascula.updateAttempts";
  const attempts = Number(sessionStorage.getItem(KEY) ?? "0");
  sessionStorage.setItem(KEY, String(attempts + 1));
  try {
    const sw = navigator.serviceWorker;
    if (sw) {
      if (attempts >= 1) await dropWorkerAndCaches(sw);
      else await switchToNewestWorker(sw);
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
