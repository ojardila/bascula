/**
 * One signal, between tabs of the same browser: "something changed, re-read".
 *
 * No data crosses the channel — only the signal. Each subscriber decides what
 * to re-fetch, and the fetch always goes back to the server. Caching a wire
 * payload here would be the same mistake `refs.ts` names about balances: a
 * figure that lived in a tab is a figure that got stale while nobody looked.
 *
 * ── WHY TWO CHANNELS ──
 *
 * The browser does not deliver a BroadcastChannel message to the channel
 * INSTANCE that posted it, but it does deliver to other instances on the same
 * name — including other instances in the SAME tab. Subscribing through one
 * channel and posting through a short-lived one lets the tab that wrote also
 * notice its own write and refresh anything on screen that is not the thing it
 * just received a response for. It is a benign extra GET and the alternative —
 * routing local writes through a separate code path — is exactly the kind of
 * bifurcation that lets one branch rot while the other is tested.
 *
 * ── WHAT HAPPENS WHEN BroadcastChannel IS MISSING ──
 *
 * Old Safari, some embedded WebViews and parts of the test matrix. Subscribers
 * install, writes publish nothing, and nothing throws. The app degrades to how
 * it has always worked: a page shows what it saw at load time until something
 * on it causes it to re-read.
 */
const CHANNEL = "bascula.mutations";

const listeners = new Set<() => void>();
let incoming: BroadcastChannel | null = null;

function ensureIncoming(): void {
  if (incoming !== null) return;
  if (typeof BroadcastChannel === "undefined") return;
  incoming = new BroadcastChannel(CHANNEL);
  incoming.onmessage = () => {
    for (const fn of listeners) fn();
  };
}

/**
 * Call `fn` whenever any tab of this browser writes. Returns an unsubscribe.
 * Safe to call before the browser supports BroadcastChannel: the subscription
 * is registered and will simply never fire.
 */
export function subscribeMutations(fn: () => void): () => void {
  ensureIncoming();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Tell every other tab (and this tab's own subscribers) that something was
 * written. The payload is deliberately a constant — the signal is the message.
 */
export function broadcastMutation(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const outgoing = new BroadcastChannel(CHANNEL);
  outgoing.postMessage(1);
  outgoing.close();
}
