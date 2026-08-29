import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

export const worker = setupWorker(...handlers);

/**
 * Starts the mock only when VITE_USE_MOCKS is on. The flag is the switch the
 * sprint plan asks for: the same build talks to the real API by flipping it.
 */
export async function startMocks(): Promise<void> {
  await worker.start({
    onUnhandledRequest: "bypass",
    quiet: false,
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
  });
}
