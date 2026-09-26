/**
 * Paths the service worker must never answer with the app shell.
 *
 * The worker serves /index.html for every navigation it is not told to skip
 * (workbox navigateFallback). That is right for client-side routes like
 * /settlements/42 and wrong for anything the API answers on the same origin.
 * /oauth/authorize is the one that bit: once somebody had opened the farm app
 * in a browser, the worker was installed on {slug}.bascula.engp.io, and when
 * ChatGPT or Claude opened the sign-in page for a connector, the worker
 * handed back the app instead. The request never reached the API, the app
 * routed itself to /entrar, and the assistant sat waiting for a callback that
 * could not come. Phones and fresh browsers, with no worker yet, worked.
 *
 * Everything under these prefixes is served by the API (see the HTTPRoute),
 * never by the SPA.
 */
export const navigateFallbackDenylist: RegExp[] = [
  /^\/v1\//,
  /^\/health/,
  /^\/landing\//,
  /^\/oauth\//,
  /^\/mcp(?:\/|\?|$)/,
  /^\/\.well-known\//,
];
