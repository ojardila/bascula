/**
 * The queue keeps weighings that could not reach the server and sends them
 * later. What must never happen: a weighing lost, or one counted twice.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/errors";
import type { WorkRecordInput } from "../api/types";
import { enqueue, flushPending, isRetryable } from "./queue";
import { listPending } from "./store";

const FARM = "farm-1";

function weighing(id: string, kg = 40) {
  return {
    id,
    farmId: FARM,
    input: { id, activityId: "a", workerId: "w", quantity: kg, dateFrom: "2026-09-25", dateTo: "2026-09-25", plotIds: ["p"], plotCropIds: [] } as WorkRecordInput,
    who: "María",
    plot: "El Alto",
    kg,
    day: "2026-09-25",
  };
}

const net = () => new ApiError(0, { error: { code: "NETWORK", message: "network" } });
const refused = () => new ApiError(422, { error: { code: "VALIDATION", message: "la persona está inactiva" } });

describe("offline queue", () => {
  it("treats no signal, auth and server trouble as «try later»", () => {
    expect(isRetryable(net())).toBe(true);
    expect(isRetryable(new ApiError(503, { error: { code: "X", message: "x" } }))).toBe(true);
    expect(isRetryable(new ApiError(401, { error: { code: "X", message: "x" } }))).toBe(true);
    expect(isRetryable(refused())).toBe(false);
  });

  it("sends in order and empties the queue, re-sending the same id", async () => {
    await enqueue(weighing("a"));
    await enqueue(weighing("b"));
    const sent: string[] = [];
    const r = await flushPending(FARM, async (i) => void sent.push(i.id));
    expect(r).toMatchObject({ sent: 2, refused: 0, stopped: false });
    expect(sent.sort()).toEqual(["a", "b"]);
    expect(await listPending(FARM)).toHaveLength(0);
  });

  it("stops at the first «no signal» and keeps everything", async () => {
    await enqueue(weighing("a"));
    await enqueue(weighing("b"));
    const r = await flushPending(FARM, async () => {
      throw net();
    });
    expect(r.stopped).toBe(true);
    expect(r.sent).toBe(0);
    expect(await listPending(FARM)).toHaveLength(2);
  });

  it("marks a refused weighing, keeps it, and goes on with the rest", async () => {
    await enqueue(weighing("a"));
    await enqueue(weighing("b"));
    const r = await flushPending(FARM, async (i) => {
      if (i.id === "a") throw refused();
    });
    expect(r).toMatchObject({ sent: 1, refused: 1 });
    const left = await listPending(FARM);
    expect(left.map((p) => p.id)).toEqual(["a"]);
    expect(left[0].error).toBeTruthy();
    // A refused one is not re-sent on every retry.
    const again: string[] = [];
    await flushPending(FARM, async (i) => void again.push(i.id));
    expect(again).toEqual([]);
  });

  it("only sees its own farm", async () => {
    await enqueue(weighing("a"));
    await enqueue({ ...weighing("z"), farmId: "other" });
    expect((await listPending(FARM)).map((p) => p.id)).toEqual(["a"]);
  });
});
