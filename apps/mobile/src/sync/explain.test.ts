/**
 * The status screen's vocabulary, against the protocol's.
 *
 * §7.1: every state is a sentence and none of them is a spinner. The screen
 * used to hold a three-branch regex, which meant a phone whose farm had been
 * suspended, or whose build the server would no longer talk to, showed the
 * raw `FARM_SUSPENDED: …` and the person reading it had no idea whether their
 * week of weighings was safe.
 *
 * The property this file pins is not "the wording is nice". It is that the
 * table cannot fall behind `protocol.ts`: every code the disposition table
 * names, plus the two the HTTP client invents, has a sentence and a verdict on
 * whether trying again can help.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { codeOf, explainSyncError } from "./explain.ts";
import { dispositionOf, type OpResult } from "./protocol.ts";
import { CODE_NETWORK, CODE_TIMEOUT } from "./http.ts";

/** Every code that can end up in `sync_state.lastError`. */
const CODES = [
  CODE_NETWORK,
  CODE_TIMEOUT,
  "PARTIAL",
  "BACKOFF",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "TOKEN_EXPIRED",
  "TOKEN_REUSED",
  "FARM_SUSPENDED",
  "RATE_LIMITED",
  "INTERNAL",
  "SCHEMA_TOO_OLD",
  "CURSOR_TOO_OLD",
];

test("every code the engine can store has a sentence, not a code", () => {
  for (const code of CODES) {
    const e = explainSyncError(`${code}: what the server said`);
    assert.notEqual(e.key, "sync.errBug", `${code} is left unexplained`);
    assert.equal(e.code, code, `${code} loses its code, which is what gets read out over the phone`);
  }
});

test("the four that halt the sync are explained as the session or as the farm", () => {
  // §4.3's `halt` row. They stop the run, so they are the ones a person is
  // most likely to be staring at, and "vuelve a conectar" is only true for
  // three of them.
  const halting = ["UNAUTHORIZED", "FORBIDDEN", "TOKEN_EXPIRED", "TOKEN_REUSED", "FARM_SUSPENDED"];
  for (const code of halting) {
    const r: OpResult = { opId: "x", status: "rejected", error: { code, message: "" } };
    assert.equal(dispositionOf(r), "halt", `${code} no longer halts the sync`);
  }

  for (const code of ["UNAUTHORIZED", "FORBIDDEN", "TOKEN_EXPIRED", "TOKEN_REUSED"])
    assert.equal(explainSyncError(`${code}: no`).key, "sync.errAuth");

  // The one nobody holding the phone can fix. Offering them a reconnect
  // button is how an afternoon is spent on a login screen.
  const suspended = explainSyncError("FARM_SUSPENDED: la finca está suspendida");
  assert.equal(suspended.key, "sync.errSuspended");
  assert.equal(suspended.retryable, false);
});

test("an app too old is not fixed by retrying, and it says so", () => {
  const e = explainSyncError("SCHEMA_TOO_OLD: this client is older than the feed");
  assert.equal(e.key, "sync.errAppOld");
  assert.equal(e.retryable, false);
});

test("no signal is one thing and something went wrong is another", () => {
  // The distinction §7.1 makes: one of them a person can act on by walking
  // towards the house, the other they cannot act on at all.
  assert.equal(explainSyncError("NETWORK: sin conexión").key, "sync.errNoSignal");
  assert.equal(explainSyncError("TIMEOUT: tardó demasiado").key, "sync.errNoSignal");
  assert.equal(explainSyncError("NETWORK: x").retryable, true);

  const bug = explainSyncError("EXPENSE_TARGET_INVALID: no such target");
  assert.equal(bug.key, "sync.errBug");
  assert.equal(bug.code, "EXPENSE_TARGET_INVALID", "the code is shown, which is the point");
  assert.equal(bug.retryable, false);
});

test("the code comes off the start of the line, not from anywhere in the text", () => {
  // The regex this replaces matched /UNAUTHORIZED|FORBIDDEN|TOKEN/ anywhere in
  // the string, so a server message that merely mentioned a token turned a
  // network hiccup into "vuelve a conectar el teléfono".
  assert.equal(codeOf("NETWORK: refresh token could not be sent"), "NETWORK");
  assert.equal(
    explainSyncError("NETWORK: refresh token could not be sent").key,
    "sync.errNoSignal",
  );
  assert.equal(codeOf("PARTIAL: quedaron cambios sin enviar"), "PARTIAL");
});

test("an error with no code shape still reaches the screen whole", () => {
  // An `INTERNAL` built from a thrown Error carries a message with colons of
  // its own, and a message nobody can parse is still better on the screen
  // than an empty card.
  const raw = "no se pudo abrir la base de datos: disk I/O error";
  const e = explainSyncError(raw);
  assert.equal(e.key, "sync.errBug");
  assert.equal(e.code, raw);
});
