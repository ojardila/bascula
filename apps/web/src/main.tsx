import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { theme } from "./theme";

/**
 * The mock is started before React renders, not alongside it. Starting the
 * service worker is async, and a request that leaves during that window goes
 * to a server nobody started — which looks like a broken app rather than a
 * race, and only on a slow machine.
 */
async function boot() {
  if (import.meta.env.VITE_USE_MOCKS === "true") {
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

boot();
