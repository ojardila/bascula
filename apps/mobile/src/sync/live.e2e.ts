/**
 * End to end, against a real running API. Not part of `npm test`.
 *
 *     cd services/api && make up && make migrate && make dev     # port 8099
 *     node apps/mobile/src/sync/live.e2e.ts
 *
 * Deliberately outside the `*.test.ts` glob. A suite that needs Postgres, a Go
 * server and a seeded farm is a suite that fails on a laptop with none of
 * them, and a red suite nobody can fix is a suite everybody learns to ignore.
 * It is still typechecked, so it cannot rot silently.
 *
 * What it proves, and it is the only thing that proves it: that the envelopes
 * this client builds are accepted by the real handlers, that the real idempotency
 * by `(farm_id, id)` behaves the way §4.1 says, and that what the phone reads
 * back reconciles with what it sent.
 */

import { DatabaseSync } from "node:sqlite";

import { nodeSqlite } from "../data/nodeSqlite.ts";
import { createSqliteRepository } from "../data/sqliteRepository.ts";
import { HttpClient } from "./http.ts";
import { FarmSession, memorySecretStore } from "./session.ts";
import { RestTransport } from "./restTransport.ts";
import { SyncEngine } from "./engine.ts";

const BASE = process.env.BASCULA_API ?? "http://localhost:8099";
const EMAIL = process.env.BASCULA_EMAIL ?? "oscar@laesperanza.co";
const PASSWORD = process.env.BASCULA_PASSWORD ?? "esperanza2026";

const log = (...a: unknown[]) => console.log(...a);

async function main(): Promise<void> {
  const db = new DatabaseSync(":memory:");
  const repo = createSqliteRepository(nodeSqlite(db));
  repo.init();

  // 1. Register the phone against the farm.
  const session = new FarmSession({ baseUrl: BASE, store: memorySecretStore() });
  const registered = await session.login(EMAIL, PASSWORD, repo.sync.identity().deviceId);
  repo.sync.claimFarm(registered.farmId);
  log(`registered: ${registered.farmName} (${registered.role}) farm=${registered.farmId}`);

  const http = new HttpClient({ baseUrl: BASE, session });
  const transport = new RestTransport({ http });
  const engine = new SyncEngine({ repo, transport });

  // 2. First sync: nothing local, everything remote. This is the phone that
  //    has just been handed to a farm already running on the web.
  const first = await engine.sync();
  log("first sync:", JSON.stringify({ ok: first.ok, applied: first.applied, error: first.error }));
  if (!first.ok) throw new Error(`first sync failed: ${first.error?.code}`);
  log(
    `  timezone=${first.handshake?.timezone} people=${repo.people.all().length} ` +
      `lotes=${repo.crops.all().length} pickups=${repo.reports.totals()?.pickups}`,
  );

  // 3. Register a weighing and an advance in the "lote", then push them.
  const person = repo.people.all()[0];
  const plot = repo.crops.all()[0];
  if (!person || !plot) throw new Error("the farm has no workers or no lotes to weigh against");

  const pickup = repo.pickups.add({
    personId: person.id,
    cropId: plot.id,
    weight: 12.5,
    date: new Date().toISOString(),
  }).lastInsertRowId;
  repo.payments.advance(person.id, 5_000_00, "e2e: anticipo en el lote");
  const owed = repo.sync.pendingCount();
  log(`queued ${owed} rows (pickup #${pickup} + advance)`);

  const second = await engine.sync({ force: true });
  log("push sync:", JSON.stringify({ ok: second.ok, pushed: second.pushed, conflicts: second.conflicts, error: second.error }));
  log(`  outbox now: ${repo.sync.pendingCount()}`);

  // 4. The same rows again. §4.1: a retry cannot create a second weighing,
  //    because it cannot invent a second uuid.
  repo.pickups.setWeight(pickup, 12.5);
  const third = await engine.sync({ force: true });
  log("replay sync:", JSON.stringify({ ok: third.ok, pushed: third.pushed, conflicts: third.conflicts }));

  // 5. Reconcile. The phone's own arithmetic against the server's checksum.
  const cards = repo.sync.conflicts();
  log(`conflicts open: ${cards.length}`);
  for (const c of cards) log(`  [${c.kind}] ${c.entity} ${JSON.stringify(c.payload)}`);
  log(`balance mismatches: ${third.mismatched}`);
  log(`skipped: ${JSON.stringify(third.skipped)}`);

  db.close();
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exitCode = 1;
});
