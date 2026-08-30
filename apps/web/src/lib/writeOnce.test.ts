/**
 * The two properties `disabled={busy}` does not have.
 *
 * Both are asserted without React's event system in the way, because the bug
 * is not about events: it is about what is true DURING a task, and what id the
 * second attempt carries.
 */
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWriteOnce } from "./writeOnce";

/** A promise the test decides when to settle, so two calls can genuinely overlap. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useWriteOnce", () => {
  /**
   * THE DOUBLE CLICK. Both calls are made in one synchronous block — no await
   * between them — which is exactly where the two events of a real double
   * click live. React has not re-rendered, so anything driven by `useState`
   * still reads its old value; the ref does not.
   */
  it("drops the second call made in the same synchronous task", async () => {
    const { result } = renderHook(() => useWriteOnce());
    const gate = deferred<string>();
    let calls = 0;

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      const run = (): Promise<unknown> =>
        result.current.run("pago|1000", async () => {
          calls += 1;
          return gate.promise;
        });
      // No await between them. This is the whole test.
      first = run();
      second = run();
      gate.resolve("ok");
      await Promise.all([first, second]);
    });

    expect(calls).toBe(1);
    await expect(first).resolves.toEqual({ ran: true, value: "ok" });
    // The caller can tell "swallowed" from "worked", which is what keeps the
    // screen from printing a receipt for a payment it never made.
    await expect(second).resolves.toEqual({ ran: false });
  });

  /**
   * THE RETRY. A failure keeps the id, so the second attempt is the same fact
   * and the server's `ON CONFLICT (id) DO NOTHING` answers with the row it
   * already has instead of writing a second payment.
   */
  it("retries with the same id after a failure", async () => {
    const { result } = renderHook(() => useWriteOnce());
    const ids: string[] = [];

    await act(async () => {
      await result.current
        .run("pago|1000", async (mint) => {
          ids.push(mint("payment"));
          throw new Error("the network dropped");
        })
        .catch(() => {});
    });
    await act(async () => {
      await result.current.run("pago|1000", async (mint) => {
        ids.push(mint("payment"));
        return "ok";
      });
    });

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  /**
   * …but a SUCCESS retires the id. Otherwise paying the same person the same
   * amount twice on purpose — which happens — would silently write once, and
   * an idempotency key that outlives its fact is a way to lose money in the
   * other direction.
   */
  it("after a success, the same amount is a new payment with a new id", async () => {
    const { result } = renderHook(() => useWriteOnce());
    const ids: string[] = [];
    const record = async (mint: (slot?: string) => string) => {
      ids.push(mint("payment"));
      return "ok";
    };

    await act(async () => {
      await result.current.run("pago|1000", record);
    });
    await act(async () => {
      await result.current.run("pago|1000", record);
    });

    expect(ids[0]).not.toBe(ids[1]);
  });

  /** A different approved figure is a different fact and must never inherit
   *  the previous id — the server would answer it with the previous payment. */
  it("a different amount is a different intent and a different id", async () => {
    const { result } = renderHook(() => useWriteOnce());
    const ids: string[] = [];

    await act(async () => {
      await result.current
        .run("pago|1000", async (mint) => {
          ids.push(mint("payment"));
          throw new Error("failed");
        })
        .catch(() => {});
      await result.current
        .run("pago|1200", async (mint) => {
          ids.push(mint("payment"));
          throw new Error("failed");
        })
        .catch(() => {});
    });

    expect(ids[0]).not.toBe(ids[1]);
  });

  /** Slots let one intent write more than one resource — a payment plus the
   *  advance for the excess — each stable on its own. */
  it("each resource of one intent gets its own stable id", async () => {
    const { result } = renderHook(() => useWriteOnce());
    const seen: string[][] = [];

    for (let i = 0; i < 2; i++) {
      await act(async () => {
        await result.current
          .run("pago|1000", async (mint) => {
            seen.push([mint("payment"), mint("advance")]);
            throw new Error("failed");
          })
          .catch(() => {});
      });
    }

    expect(seen[0][0]).not.toBe(seen[0][1]);
    expect(seen[0]).toEqual(seen[1]);
  });

  /** `retire` is for the failure that kills the approved figure rather than
   *  inviting a retry: the gross moved, so the next attempt is a new fact. */
  it("retire() discards the id of a figure that can no longer be retried", async () => {
    const { result } = renderHook(() => useWriteOnce());
    const ids: string[] = [];

    await act(async () => {
      await result.current
        .run("pago|1000", async (mint) => {
          ids.push(mint("payment"));
          throw new Error("the gross moved");
        })
        .catch(() => {});
      result.current.retire("pago|1000");
      await result.current
        .run("pago|1000", async (mint) => {
          ids.push(mint("payment"));
          throw new Error("again");
        })
        .catch(() => {});
    });

    expect(ids[0]).not.toBe(ids[1]);
  });

  /** A failure releases the gate; otherwise one bad request locks the screen. */
  it("a failure releases the gate", async () => {
    const { result } = renderHook(() => useWriteOnce());
    let calls = 0;

    await act(async () => {
      await result.current
        .run("pago|1000", async () => {
          calls += 1;
          throw new Error("failed");
        })
        .catch(() => {});
    });
    await act(async () => {
      await result.current
        .run("pago|1000", async () => {
          calls += 1;
          throw new Error("failed");
        })
        .catch(() => {});
    });

    expect(calls).toBe(2);
  });
});
