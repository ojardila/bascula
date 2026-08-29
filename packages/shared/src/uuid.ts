/**
 * UUIDv7 — the identity a row keeps once it leaves the phone.
 *
 * Why here and not in the app: the phone mints these ids, the Go API stores
 * them and the web reads them back, and all three have to agree on what an id
 * *means*. A v7 is not an opaque token — its first 48 bits are the millisecond
 * the row was created, so `ORDER BY uuid` is `ORDER BY when it happened`. The
 * server pages through a device's history with a plain `WHERE uuid > ?`, with
 * no cursor table and no clock comparison. That property is a contract, so it
 * lives with the rest of the contract (`docs/arquitectura-api.md` §7).
 *
 * Layout (RFC 9562 §5.7):
 *
 *     unix_ts_ms (48) | ver=7 (4) | rand_a (12) | var=0b10 (2) | rand_b (62)
 *
 * `rand_a` is used as the monotonic counter RFC 9562 §6.2 "method 2" allows,
 * so two rows written in the same millisecond still come out in the order they
 * were written. Without it a season's backfill — eighteen thousand rows, many
 * sharing a millisecond because they were seeded from the same `createdAt` —
 * would come out in random order inside every tie, and the server would
 * receive a history that is only approximately chronological. Approximately is
 * not good enough when the order decides which settlement claims a pickup.
 */

/** 12 bits of counter, then the millisecond has to move on. */
const COUNTER_MAX = 0xfff;

/**
 * 62 random bits, as two halves the number type can hold exactly.
 *
 * Prefers a real CSPRNG. `expo-crypto` installs `globalThis.crypto` on the
 * phone and Node has had it for years, but React Native has shipped without it
 * before, and a data layer that throws on first launch because a polyfill
 * moved is not a trade worth making: the timestamp and counter already
 * guarantee uniqueness *on this device*, and the random half only has to make
 * a collision with another device implausible.
 */
function randomBits(): { hi: number; lo: number } {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } };
  const buf = new Uint32Array(2);
  if (typeof g.crypto?.getRandomValues === "function") g.crypto.getRandomValues(buf);
  else {
    buf[0] = Math.floor(Math.random() * 0x100000000);
    buf[1] = Math.floor(Math.random() * 0x100000000);
  }
  return { hi: buf[0]!, lo: buf[1]! };
}

const hex = (n: number, digits: number) =>
  (n >>> 0).toString(16).padStart(digits, "0").slice(-digits);

export type UuidV7 = (at?: Date | number) => string;

/**
 * A generator whose output only ever increases.
 *
 * It is a factory rather than a module-level function on purpose. The
 * repository holds one for its own writes, and the v6 migration holds a
 * *separate* one that it drives through the farm's whole history in
 * chronological order; sharing a counter between the two would make the
 * migration's first row inherit the clock of the last row the app wrote.
 *
 * When asked for an instant that is not after the last one it emitted, it
 * keeps the previous millisecond and advances the counter instead. So callers
 * get monotonicity for free, and the only thing they must do to get
 * *chronological* uuids is feed the instants in ascending order.
 */
export function createUuidV7(random: () => { hi: number; lo: number } = randomBits): UuidV7 {
  let lastMs = -1;
  let counter = 0;

  return function uuidV7(at: Date | number = Date.now()): string {
    const asked = Math.floor(typeof at === "number" ? at : at.getTime());
    const ms = Number.isFinite(asked) ? Math.max(0, asked) : 0;

    if (ms > lastMs) {
      lastMs = ms;
      counter = 0;
    } else if (counter < COUNTER_MAX) {
      counter += 1;
    } else {
      // 4096 rows inside one millisecond. Borrow from the next one rather than
      // wrap: a repeated uuid would be silently merged by the server as the
      // same row, which is the one failure mode this whole column exists to
      // prevent.
      lastMs += 1;
      counter = 0;
    }

    const { hi, lo } = random();
    // 48-bit timestamp, big-endian, split as the canonical form wants it.
    const tsHigh = Math.floor(lastMs / 0x10000); // bits 47..16
    const tsLow = lastMs % 0x10000; // bits 15..0
    // Version nibble, then the counter in rand_a.
    const verAndCounter = 0x7000 | counter;
    // Variant `10`, then the first 14 bits of rand_b...
    const varAndRand = 0x8000 | (hi & 0x3fff);
    // ...and its remaining 48, which stay inside an exact integer.
    const tail = ((hi >>> 14) & 0xffff) * 0x100000000 + (lo >>> 0);

    return (
      `${hex(tsHigh, 8)}-${hex(tsLow, 4)}-${hex(verAndCounter, 4)}-` +
      `${hex(varAndRand, 4)}-${tail.toString(16).padStart(12, "0")}`
    );
  };
}

// There is deliberately no shared module-level generator. Monotonicity is a
// property of a *sequence*, so a singleton would silently drag any caller
// asking for a past instant — exactly what the v6 backfill does — up to
// whatever the last caller's clock was. Own your generator, or take the bug.

/** Is this a well-formed v7, variant bits and all? */
export function isUuidV7(s: unknown): s is string {
  return (
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s)
  );
}

/**
 * The millisecond a v7 was minted for. The whole reason the column is a v7 and
 * not a v4: the server can date a row without trusting a separate timestamp
 * column, and the migration's own test can check that every backfilled uuid
 * really does carry the row's date.
 */
export function uuidV7Time(uuid: string): number {
  if (!isUuidV7(uuid)) throw new Error(`not a uuidv7: ${uuid}`);
  return parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
}

/** The 12-bit sequence inside the millisecond. Exposed for the tests. */
export function uuidV7Counter(uuid: string): number {
  if (!isUuidV7(uuid)) throw new Error(`not a uuidv7: ${uuid}`);
  return parseInt(uuid.slice(15, 18), 16);
}
