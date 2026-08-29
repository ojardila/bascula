/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

/**
 * The live-API suite has its own config because it is a different kind of test
 * and must not be able to pass by accident.
 *
 * `npm test` is hermetic: jsdom, MSW, no network, fast, runs on every save.
 * This one needs a Go server, a Postgres behind it, and migrations applied. If
 * it were part of the default run, one of two bad things would happen —
 * either the default run starts failing on a laptop with no Docker, or the
 * suite gets marked "skip if it fails", which is the same as deleting it.
 *
 * The differences that matter:
 *
 *   no setupFiles from src/test    that one starts MSW, which would intercept
 *                                  every request and make this suite a very
 *                                  slow way of testing the mock
 *   VITE_API_BASE_URL is absolute  there is no dev-server proxy here, so the
 *                                  client has to be given the whole origin
 *   VITE_USE_MOCKS=false           belt and braces
 *   no parallelism, no retries     it writes to a real database; two files
 *                                  racing on one farm's ledger would produce
 *                                  failures nobody can reproduce
 */
const API_URL = process.env.BASCULA_API_URL ?? "http://localhost:8099";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["e2e/**/*.test.ts"],
    setupFiles: ["./e2e/setup.ts"],
    env: {
      VITE_API_BASE_URL: API_URL,
      VITE_API_URL: API_URL,
      VITE_USE_MOCKS: "false",
    },
    // One file at a time, one fork. The suite creates a farm and moves money
    // through it; concurrency here buys nothing and costs reproducibility.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 0,
  },
});
