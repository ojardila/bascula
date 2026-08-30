/**
 * The one switch.
 *
 * `docs/simplificacion.md` is the plan: the phone stops calculating money, and
 * settling and paying move to the web console. This file is the preparation
 * for that, and NOT the execution of it. Nothing is deleted this sprint,
 * because the farm settles and pays from this handset every Saturday and the
 * web cannot yet pay a crew — `simplificacion.md` §2.1: «se muda a la web — y
 * en la web no existe todavía». Taking it away before then leaves the farm
 * with no way to pay anybody.
 *
 * What this file buys is that the removal becomes a one-line change with a
 * one-line undo, instead of surgery on six screens on a day somebody is in a
 * hurry. Flip `LOCAL_SETTLEMENT` to `false` and the app must still be
 * coherent, which is a stronger claim than "the buttons are hidden":
 *
 *   - **No dead buttons.** Nothing that calls `settle`, `pay`, `runPayroll`,
 *     `undoRun` or `voidSettlement` is reachable.
 *   - **No orphan screens.** Every route is still reachable from somewhere and
 *     every screen still has a reason to exist when it is opened. A screen
 *     whose only purpose was settling says where settling happens now instead
 *     of rendering an empty shell.
 *   - **It says where the work moved.** A foreman who has pressed the same two
 *     buttons for months is owed a sentence, not a missing control.
 *   - **It is still useful.** Weigh, read the balance, hand over an advance,
 *     print its voucher. That is the whole of `simplificacion.md` §2.1's
 *     "después" column, and `flagOff.test.ts` walks it.
 *
 * Why a constant and not `capabilities.settleOffline` from the handshake:
 * those are different questions and conflating them is how a farm loses a
 * Saturday. The capability is the SERVER's answer to «may this phone settle
 * right now», it is already false by decision 5, and `PayWorker` already
 * honours the freshness rule it implies. This flag is OURS: it says whether
 * the code for settling locally exists in the product at all. The capability
 * turns a button off for an afternoon; the flag is the demolition notice. When
 * the flag goes false for good, the capability and the code behind it are what
 * `simplificacion.md` §1.1 deletes — and until then, wiring the flag to the
 * handshake would let a server outage silently take the farm's payroll away.
 */

/**
 * Whether this build settles and pays from the handset.
 *
 * TRUE today, deliberately: it is what the farm uses. Flip to `false` only
 * after the web can settle and pay a whole crew in one screen with its signed
 * sheet, and after somebody has done it once with the paper in front of them
 * (`simplificacion.md` §6, and P7 of §4).
 */
export const LOCAL_SETTLEMENT = true;
