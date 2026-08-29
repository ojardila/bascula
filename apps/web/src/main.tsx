import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { theme } from "./theme";
import { USE_MOCKS, announceApiMode } from "./api/mode";

/**
 * The mock is started before React renders, not alongside it. Starting the
 * service worker is async, and a request that leaves during that window goes
 * to a server nobody started — which looks like a broken app rather than a
 * race, and only on a slow machine.
 */
/**
 * Take the mock's service worker out of the browser when mocks are off.
 *
 * A service worker outlives the page that registered it, the tab, and the
 * setting that asked for it. Switching VITE_USE_MOCKS to false and reloading
 * used to leave the worker MSW had installed still sitting between the app and
 * the network, so requests meant for the real server were answered by a mock
 * that had never heard of the farm — which reads as "wrong email or password"
 * on a password that is perfectly correct.
 *
 * The reload is needed because a page already claimed by a worker stays claimed
 * until it is loaded again. It happens at most once: after unregistering there
 * is nothing left to find.
 */
async function dropStaleMockWorker(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  let removed = false;
  try {
    for (const reg of await navigator.serviceWorker.getRegistrations()) {
      const url = reg.active?.scriptURL ?? reg.installing?.scriptURL ?? reg.waiting?.scriptURL ?? "";
      if (url.includes("mockServiceWorker.js")) {
        await reg.unregister();
        removed = true;
      }
    }
  } catch {
    // A browser that will not talk about its workers cannot have one of ours.
    return false;
  }
  return removed && navigator.serviceWorker.controller !== null;
}

async function boot() {
  announceApiMode();

  if (!USE_MOCKS && (await dropStaleMockWorker())) {
    console.warn("Báscula: se retiró el service worker de los datos simulados; recargando.");
    window.location.reload();
    return;
  }

  if (USE_MOCKS) {
    const { startMocks } = await import("./mocks/browser");
    await startMocks();
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </StrictMode>,
  );
}

// A failure in here used to leave the page blank: the mock's service worker
// never registers, the promise never settles, and nothing ever renders. The
// console knew and the screen did not. A blank tab is the least actionable bug
// report there is, so say it on the page — and say what to do about it.
boot().catch((err: unknown) => {
  const root = document.getElementById("root");
  if (!root) return;
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const isMock = err instanceof Error && err.name === "MockStartupError";
  const escape = (t: string) =>
    t.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);

  root.innerHTML = `
    <div style="font:16px/1.6 system-ui,sans-serif;max-width:44rem;margin:4rem auto;padding:0 1.5rem;color:#1b1b1b">
      <h1 style="font-size:1.4rem;color:#1b5e20;margin:0 0 .75rem">
        ${isMock ? "Los datos simulados no arrancaron" : "La aplicación no pudo arrancar"}
      </h1>
      <p style="margin:0 0 1rem">${
        isMock
          ? "La aplicación está bien; lo que no arrancó es el service worker que finge ser el servidor."
          : "Falló antes de dibujar nada, así que esto es lo único que hay:"
      }</p>
      <pre style="background:#f4f4f4;padding:1rem;border-radius:.5rem;overflow-x:auto;white-space:pre-wrap;margin:0 0 1.25rem">${escape(
        detail,
      )}</pre>
      ${
        isMock
          ? `<p style="margin:0 0 .5rem"><strong>Lo más rápido:</strong> use la API de verdad, que no necesita service worker.</p>
             <ol style="margin:0 0 1rem;padding-left:1.25rem">
               <li>En <code>apps/web/.env.development</code>, ponga <code>VITE_USE_MOCKS=false</code></li>
               <li>Levante el servidor: <code>cd services/api &amp;&amp; make up &amp;&amp; make migrate &amp;&amp; make dev</code></li>
               <li>Recargue esta página</li>
             </ol>
             <p style="margin:0;color:#555">Si prefiere los datos simulados: pruebe en una ventana normal
             (no de incógnito), recargue con Cmd+Shift+R, y revise que ninguna extensión bloquee
             los service workers.</p>`
          : `<p style="margin:0;color:#555">Recargue con Cmd+Shift+R. Si insiste, el detalle completo
             está en la consola del navegador.</p>`
      }
    </div>`;
  console.error("boot failed", err);
});
