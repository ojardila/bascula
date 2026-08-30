/**
 * THE NUMBER THE OWNER WOULD READ OUT LOUD IF SOMEBODY DISPUTES A PAYMENT.
 *
 * The API does not issue receipt numbers, so the console printed the movement
 * id — a 36-character UUID — at the head of the payment receipt. That is
 * exactly the piece of data that gets used when there is a dispute: somebody
 * calls, reads the receipt out over the phone, and the other end writes it
 * down. Nobody dictates "0192f3a0-0009-7000-8000-000000000003" without a
 * mistake, and whoever tries concludes, rightly, that the paper is not meant
 * for them.
 *
 * So the receipt is headed with the last eight digits of the id, in two blocks
 * of four and in upper case: `3F7A-91C2`. It is dictated in one go, written
 * down by hand, and searched for — the full id still goes in the footer of the
 * paper, in small type, because that is what support needs and not what the
 * owner reads.
 *
 * IT IS NOT A SEQUENCE NUMBER and does not pretend to be. A per-farm sequence
 * is a server column and the server's decision; inventing one here would give
 * two receipts numbered "N.º 14" the moment two devices write at once. This is
 * the same identifier, written for a person. The day the API issues sequence
 * numbers, this function is deleted and `receiptNumber` comes from the server.
 *
 * UUIDv7s share a prefix (they are ordered by time) and not a tail: the last
 * digits are the random part, which is precisely what tells two payments from
 * the same afternoon apart.
 */

/** `0192f3a0-…-8000-00000000ab3f` -> `0000-AB3F`. */
export function shortReceiptNumber(id: string): string {
  const hex = id.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length < 8) return id.toUpperCase();
  const tail = hex.slice(-8).toUpperCase();
  return `${tail.slice(0, 4)}-${tail.slice(4)}`;
}
