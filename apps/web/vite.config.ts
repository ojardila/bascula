/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";

/**
 * THE PROXY IS NOT A CONVENIENCE. It is the only way this app can reach the
 * real API from a browser.
 *
 * `services/api` mounts RequestID, RealIP and Recoverer and nothing else —
 * there is no CORS middleware anywhere in the service (grep it). So a page
 * served from :5173 that fetches http://localhost:8099/v1/me gets a preflight
 * with no `Access-Control-Allow-Origin` on the way back, and the browser
 * refuses the response before any of our code sees it. The failure looks like
 * a network error, which sends you hunting in the wrong half of the system.
 *
 * Proxying makes the API same-origin as far as the browser is concerned, so
 * there is no preflight to fail. It also means `VITE_API_BASE_URL` stays empty
 * and every request in the app is a relative `/v1/...` — which is what MSW
 * matches too, so mock mode and real mode use identical URLs.
 *
 * In production the same property has to hold by deployment rather than by
 * dev-server: serve the built assets behind the same origin as the API, or put
 * a reverse proxy in front of both. If the API ever grows a CORS middleware,
 * this can go and `VITE_API_BASE_URL` can point straight at the server.
 */
/**
 * INSTALLABLE, AND THE WEIGHING SCREEN OPENS WITH NO SIGNAL.
 *
 * The service worker precaches the app shell (the built JS, CSS, HTML and
 * icons) and nothing else. API responses are never cached here: a stale
 * balance shown as if it were today's is worse than a screen that says it
 * needs internet. The only data kept on the device is what `src/offline`
 * keeps on purpose, in IndexedDB: the people and lotes for the weighing
 * screen, and weighings waiting to be uploaded.
 *
 * Every navigation falls back to index.html so a client route opens offline,
 * except /v1 and /health, which must always reach the network. The landing's
 * images under /landing are left out of the precache: they are heavy and a
 * farm's data plan pays for them.
 *
 * The worker file itself and index.html are served no-cache by nginx.conf, so
 * a deploy reaches the phone on the next open.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const target = env.VITE_API_URL || "http://localhost:8099";

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: false,
        devOptions: { enabled: false },
        manifest: {
          name: "Báscula",
          short_name: "Báscula",
          description: "Registro de cosecha y cuentas por recolector.",
          lang: "es-CO",
          dir: "ltr",
          // Signed-in people are sent on to their own home from here; the
          // landing at "/" is for visitors, not for the icon on the phone.
          start_url: "/entrar",
          scope: "/",
          display: "standalone",
          orientation: "any",
          theme_color: "#2e7d32",
          background_color: "#ffffff",
          icons: [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
            { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
            { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml" },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
          globIgnores: ["landing/**", "mockServiceWorker.js"],
          navigateFallback: "/index.html",
          navigateFallbackDenylist: [/^\/v1\//, /^\/health/, /^\/landing\//],
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/,
              handler: "CacheFirst",
              options: {
                cacheName: "google-fonts",
                expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
      }),
    ],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
      port: 5173,
      proxy: {
        // Both prefixes: /health is how the app tells "the server is down"
        // apart from "the server said no".
        "/v1": { target, changeOrigin: true },
        "/health": { target, changeOrigin: true },
      },
    },
    build: {
      rollupOptions: {
        output: {
          // MUI is most of the weight and it changes far less often than the
          // app does. Splitting it means a deploy does not re-download 500 kB
          // over a farm's connection.
          manualChunks: {
            react: ["react", "react-dom", "react-router-dom"],
            mui: ["@mui/material", "@mui/icons-material"],
          },
        },
      },
    },
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      css: false,
      // The live-API suite is not a unit test: it needs a server on :8099 and
      // a database behind it. It has its own config and its own npm script so
      // that `npm test` stays hermetic and fast.
      exclude: ["node_modules/**", "dist/**", "e2e/**"],
    },
  };
});
