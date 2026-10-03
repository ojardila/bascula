/**
 * Passkey autofill on the login screen (WebAuthn conditional mediation).
 *
 * With `autocomplete="username webauthn"` on the email field, a pending
 * `navigator.credentials.get({ mediation: "conditional" })` makes the phone
 * or the browser suggest the person's passkey right in the field's
 * suggestions, with no button to find. Picking it signs in.
 *
 * The request stays pending until the person picks or leaves, but the
 * server's challenge lives five minutes, so each round is abandoned and a
 * fresh one started before that. After a pick, the answer is handed over and
 * a new round starts, in case that sign-in failed and the person tries again.
 */

/** Renew before the five-minute challenge lapses. */
export const AUTOFILL_RENEW_MS = 270_000;

export interface AutofillOptions<T> {
  /** Ask for a challenge and wait for the pick; must honour the signal. */
  readonly request: (signal: AbortSignal) => Promise<T>;
  /** Sign in with the picked passkey. */
  readonly onAnswer: (answer: T) => Promise<void>;
  readonly renewMs?: number;
}

/** Starts listening; returns the function that stops it for good. */
export function startPasskeyAutofill<T>({
  request,
  onAnswer,
  renewMs = AUTOFILL_RENEW_MS,
}: AutofillOptions<T>): () => void {
  let live = true;
  let current: AbortController | null = null;
  let renew: ReturnType<typeof setTimeout> | undefined;

  const round = async (): Promise<void> => {
    if (!live) return;
    const mine = new AbortController();
    current = mine;
    renew = setTimeout(() => {
      mine.abort();
      void round();
    }, renewMs);
    let answer: T;
    try {
      answer = await request(mine.signal);
    } catch {
      // Aborted: renewed (a new round already runs) or stopped. Anything
      // else: this browser will not do it; the button still works.
      if (!mine.signal.aborted) clearTimeout(renew);
      return;
    }
    clearTimeout(renew);
    if (!live) return;
    try {
      await onAnswer(answer);
    } catch {
      // The sign-in shows its own error.
    }
    void round();
  };

  void round();
  return () => {
    live = false;
    clearTimeout(renew);
    current?.abort();
  };
}
