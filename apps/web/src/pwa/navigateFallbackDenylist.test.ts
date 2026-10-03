// SPDX-License-Identifier: MIT
import { navigateFallbackDenylist } from "./navigateFallbackDenylist";

const denied = (path: string) => navigateFallbackDenylist.some((re) => re.test(path));

describe("service worker navigate fallback", () => {
  it("never answers the API's own pages with the app shell", () => {
    for (const p of [
      "/oauth/authorize",
      "/oauth/authorize?response_type=code&client_id=x",
      "/mcp",
      "/mcp?x=1",
      "/mcp/",
      "/mcp/docs",
      "/mcp/docs#tool-me",
      "/mcp/tools.json",
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/v1/me",
      "/health",
    ]) {
      expect(denied(p), p).toBe(true);
    }
  });

  it("still serves client-side routes from the shell", () => {
    for (const p of ["/", "/entrar", "/settlements/42", "/mcpx", "/configuracion"]) {
      expect(denied(p), p).toBe(false);
    }
  });
});
