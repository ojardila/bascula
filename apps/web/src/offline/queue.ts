/**
 * Uploading the weighings the phone kept while there was no signal.
 *
 * Each one carries the id it was given when it was typed, and the server
 * answers a repeated id with the record it already has. So sending one twice
 * — the connection dropped after the server wrote it but before the answer
 * arrived — is harmless, and the queue can simply retry until it hears back.
 *
 * What stops the upload and what does not:
 *  - No network, a server that is down (5xx), a timeout or an expired
 *    session: STOP and keep everything. It will go up later, untouched.
 *  - The server refused this one weighing (a 4xx that is about the data: a
 *    lote that no longer exists, a week already paid): mark it with the
 *    server's reason, keep it on the phone so somebody can read it, and go on
 *    with the next. Nothing is ever dropped without a person seeing it.
 */
import { api } from "../api/endpoints";
import { ApiError, messageFor } from "../api/errors";
import type { WorkRecordInput } from "../api/types";
import { deletePending, listPending, putPending, type PendingWeighing } from "./store";

export type Send = (input: WorkRecordInput) => Promise<unknown>;

export interface FlushResult {
  sent: number;
  refused: number;
  /** True when it stopped early and the rest is still waiting for a connection. */
  stopped: boolean;
}

/** Worth trying again later, as opposed to a refusal about the data itself. */
export function isRetryable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  return e.status === 0 || e.status === 401 || e.status === 408 || e.status === 429 || e.status >= 500;
}

export async function flushPending(farmId: string, send: Send = (i) => api.createWorkRecord(i)): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, refused: 0, stopped: false };
  for (const p of await listPending(farmId)) {
    if (p.error) continue;
    try {
      await send(p.input);
      await deletePending(p.id);
      result.sent += 1;
    } catch (e) {
      if (isRetryable(e)) {
        result.stopped = true;
        break;
      }
      await putPending({ ...p, error: messageFor(e) });
      result.refused += 1;
    }
  }
  return result;
}

export async function enqueue(p: Omit<PendingWeighing, "createdAt" | "error">): Promise<void> {
  await putPending({ ...p, createdAt: new Date().toISOString(), error: null });
}
