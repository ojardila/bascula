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
 *
 * ## What comes out when it goes false, measured against THIS commit
 *
 * `simplificacion.md` §1.1 and §1.2 give line ranges against `b539d08` and
 * they no longer resolve — the files have grown, and a demolition list whose
 * line numbers point at the wrong functions is worse than none on the day
 * somebody is in a hurry. So the inventory is kept here, next to the switch,
 * by SYMBOL rather than by line: a name still resolves after the file moves.
 *
 * **Deleted outright — application code, ≈ 1,730 lines**
 *
 *   `data/sqliteRepository.ts`   `pendingItems` · `reverseHere` ·
 *                                `voidSettlementHere`                   104
 *     inside `payments`          `preview` · `settle` · `voidSettlement` ·
 *                                `runPayroll` · `pay` · `adjust` ·
 *                                `reverse` · `undoRun` · `paidAgainst` ·
 *                                `paidInRange` · `pendingAll`           222
 *   `schema.ts`                  `BALANCE_COLUMNS` · `BALANCE_SQL` ·
 *                                `PAID_AGAINST_SQL` · `PAID_IN_RANGE_SQL` ·
 *                                `PENDING_SQL` · `ux_items_pickup_live`  41
 *   `data/syncStore.ts`          `applySettlement`                       76
 *   `sync/engine.ts`             `checkBalances`, plus the `settlements`
 *                                and `settlement_items` branches of
 *                                `envelope` / `readOnlyEnvelope`          78
 *   `receiptHtml.ts`             `payrollHtml`                          132
 *   `screens/PayWorker.tsx`      whole file                             434
 *   `screens/PaymentsPanel.tsx`  whole file                             553
 *   `data/repository.ts`         14 of the 19 `PaymentsRepo` methods and
 *                                the types `SettlementPreview`,
 *                                `PendingItem`, `PayrollRun`,
 *                                `SettleResult`, `PendingWorker`       ~90
 *
 * **Rewritten smaller, ≈ −380 lines net**
 *
 *   `payments.balance` / `balances` / `fullBalance`   58 → ~25
 *   `screens/Account.tsx`      read-only              478 → ~200
 *   `screens/Adjust.tsx`       only the `anticipo`    181 → ~110
 *
 * **Deleted — tests, ≈ 2,490 lines**
 *
 *   `data/repository.test.ts`    36 of 63 tests                        734
 *   `sync/sync.test.ts`          11 of 26 (pulled settlements, the
 *                                balance checksum)                     620
 *   `ledger.test.ts`             9 of 13; the file loses its subject   186
 *   `receiptHtml.test.ts`        6 of 15 (the payroll sheet)            74
 *   `packages/shared/golden/`    `runner.ts` 523 + `golden.test.ts` 87
 *                                + `real-repository.test.ts` 265       875
 *                                The ten `cases/*.json` STAY: they are
 *                                already the server's regression suite
 *                                in `internal/apitest/golden_test.go`.
 *
 * **≈ 4,600 lines out.** More than §1.1's 3,927, because the product grew
 * since that count and the settling code grew with it — which is the argument
 * for doing it rather than against.
 *
 * Written in exchange: §1.1 budgeted ~220 lines for an `anticipo` screen, the
 * balance-as-read card and the `server_balances` read. All three now EXIST —
 * `Adjust.tsx`, `balanceDisplay.ts` and `recordServerBalances` — so the
 * exchange is close to nothing and the net is close to the gross.
 *
 * On the server, not one line. `handlers_sync.go`'s rejection branch goes from
 * the one that fires to the one that never fires, which is where a guard
 * belongs.
 *
 * ## What was checked, with the flag actually off
 *
 * Not reasoned about — run. `LOCAL_SETTLEMENT = false`, then the whole suite:
 * `tsc --noEmit` clean, and 259 of 260 tests green. The one red is the
 * tripwire in `flagOff.test.ts` that asserts the flag ships ON, which is the
 * single line that is SUPPOSED to fail the day somebody flips it. Nothing
 * else broke: no orphan screen, no dead control, and `importScreen.test.ts`'s
 * sweep of every translation key every screen asks for — the literal ones and
 * the four families built at run time — passes in all three languages with
 * the flag off, so no screen falls back to printing a raw key.
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
