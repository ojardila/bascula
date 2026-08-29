import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

export const worker = setupWorker(...handlers);

/**
 * Starts the mock only when VITE_USE_MOCKS is on. The flag is the switch the
 * sprint plan asks for: the same build talks to the real API by flipping it.
 */
/**
 * How long to wait for the service worker before giving up on it.
 *
 * `worker.start()` can hang rather than fail: registering a service worker is a
 * promise that simply never settles when the browser will not give us one —
 * a private window, a policy, an extension, a headless run. Awaiting it with no
 * bound leaves the page blank for ever, with the reason only in the console.
 * Ten seconds is far longer than a healthy registration and far shorter than
 * "the app is broken".
 */
const WORKER_TIMEOUT_MS = 10_000;

export class MockStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockStartupError";
  }
}

export async function startMocks(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    throw new MockStartupError(
      "Este navegador no ofrece service workers, y los datos simulados los necesitan.",
    );
  }

  const started = worker.start({
    onUnhandledRequest: "bypass",
    quiet: false,
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
  });

  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new MockStartupError(
            `El service worker de los datos simulados no arrancó en ${
              WORKER_TIMEOUT_MS / 1000
            } segundos.`,
          ),
        ),
      WORKER_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([started, timedOut]);
  } finally {
    clearTimeout(timer!);
  }
}
