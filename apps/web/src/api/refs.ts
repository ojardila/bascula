/**
 * The lookup tables the client needs because the server sends ids, not names.
 *
 * A work record on the wire is five UUIDs and a quantity. The table on
 * `WorkRecordsPage` has columns headed Empleado, Actividad and Lotes. Somebody
 * has to join those, and the choice is: denormalise server-side, or resolve
 * client-side against data the client already holds.
 *
 * Client-side, for two reasons. The obvious one is that the server has already
 * decided — there are no names on those payloads and adding them would put the
 * same string in two tables and let them drift. The less obvious one is that
 * the screens showing joined names are exactly the screens that already load
 * workers, activities and plots for their own filters and pickers. The join
 * costs nothing extra there; it only looks expensive when you imagine fetching
 * the reference data solely to render a name.
 *
 * So: one cache, four lists, loaded once per session and invalidated when the
 * app itself writes to one of them.
 *
 * WHAT THIS IS NOT. It is not a general-purpose store and it must not become
 * one. Nothing here is rendered directly; the maps exist to turn an id into a
 * string. In particular the cache holds NO money and no balances — those are
 * derived on the server on every read, and a cached balance is precisely the
 * stale figure that gets somebody paid twice.
 *
 * FAILURE. A caller who may not read one of the lists (the weigher may not
 * read plots' crops, an anonymous caller may read nothing) gets an empty map
 * for that table, never a rejected promise. Reference data is a nicety; a
 * screen must render without it, showing "—" where a name would have been.
 * Making the join failure fatal would turn a 403 on a secondary list into a
 * blank page for the primary one.
 */
import { http } from "./client";
import type { PayMode, Uuid } from "./types";
import type {
  WireActivity,
  WireEmployee,
  WireList,
  WirePlot,
  WireWorkerPublic,
  WireWorkUnit,
} from "./wire";
import { cropLabel, payModeFromWire, type Refs } from "./adapters";

let cache: Promise<Refs> | null = null;

/** Drop the cache. Called after any write that changes a name or adds a row. */
export function invalidateRefs(): void {
  cache = null;
}

/**
 * The reference data, loaded at most once until something invalidates it.
 *
 * Concurrent callers share one promise: four screens mounting at the same
 * moment must not produce four rounds of the same four requests. This is the
 * same single-flight discipline `client.ts` applies to token refresh, for the
 * same reason.
 */
export function loadRefs(): Promise<Refs> {
  if (!cache) cache = fetchRefs();
  return cache;
}

/** Never rejects: a list the caller may not read becomes an empty list. */
async function listOrEmpty<T>(path: string): Promise<T[]> {
  try {
    const res = await http.get<WireList<T>>(path);
    return res?.items ?? [];
  } catch {
    return [];
  }
}

async function fetchRefs(): Promise<Refs> {
  const [workers, activities, units, plots] = await Promise.all([
    listOrEmpty<WireEmployee | WireWorkerPublic>("/v1/workers"),
    listOrEmpty<WireActivity>("/v1/activities"),
    listOrEmpty<WireWorkUnit>("/v1/catalogs/work-units"),
    listOrEmpty<WirePlot>("/v1/plots"),
  ]);

  const refs: Refs = {
    workers: new Map<Uuid, string>(),
    activities: new Map<Uuid, { name: string; category: string; payMode: PayMode }>(),
    units: new Map<Uuid, string>(),
    plots: new Map<Uuid, string>(),
    crops: new Map<Uuid, string>(),
  };

  for (const w of workers) {
    // `lastName` is nullable and a worker known only by a first name is
    // ordinary, so the join must not produce a trailing space.
    refs.workers.set(w.id, [w.name, w.lastName].filter(Boolean).join(" "));
  }
  for (const a of activities) {
    refs.activities.set(a.id, {
      name: a.name,
      category: a.category,
      payMode: payModeFromWire(a.payScheme),
    });
  }
  for (const u of units) {
    // The short code is what belongs beside a number: "38,5 kg", not
    // "38,5 Kilo".
    refs.units.set(u.id, u.code || u.label);
  }
  for (const p of plots) {
    refs.plots.set(p.id, p.name);
    for (const c of p.crops ?? []) refs.crops.set(c.id, cropLabel(c));
  }

  return refs;
}
