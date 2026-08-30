/**
 * CREW PAYROLL. The screen where the most money moves in one go.
 *
 * The product reasoning —why two steps, how the race is resolved for a group,
 * why the undo runs in that order— is written down in `crew.ts`, which is
 * where the logic lives and where it can be tested without rendering. What is
 * left here is what belongs to the screen, and it is five things:
 *
 *  1. **See it before you sign it.** The table shows who is getting paid and
 *     how much; every row opens up and shows WHY —activity, date, quantity and
 *     price per unit, line by line— and the farm's total sits underneath. The
 *     confirmation dialog lists everybody again with their amount: nobody
 *     presses a button that hands out two million pesos having seen only a
 *     total.
 *
 *  2. **The race guard.** `checkSettleRun` / `checkPayRun` run BEFORE anything
 *     is written. If a single person's figure changed, nothing is written for
 *     anybody and the dialog says whose and what moved, in the same sentence
 *     as the single-person screen (`grossChange.sentenceFor`). Just as there,
 *     the only way out is "Volver a revisar": there is no retry, because a
 *     retry would resend the expired approval.
 *
 *  3. **The double click.** `useWriteOnce` from the very first line. A crew
 *     payroll fired twice is the worst possible case of that bug: it is not
 *     $10.000 too much, it is thirty payments. The `intent` names the whole
 *     run —step, people and amount— so two clicks produce the same string and
 *     therefore the same ids, and changing the selection produces another.
 *
 *  4. **The undo.** A button that says exactly what it is about to undo before
 *     it does it, and exactly what it undid afterwards.
 *
 *  5. **The paper.** The payroll sheet with its column of signatures — and if
 *     a filter was on, or somebody was unticked, or somebody did not get in,
 *     the paper says so top and bottom. It is the bite `SettlementsPage` took
 *     out of us, which here has two more ways to happen.
 *
 * The sync warning from `AppShell` stays on top of all this while the move is
 * unfinished: today this screen and the phone's `PaymentsPanel` can both pay
 * the same person in the same week.
 */
import { Fragment, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, AlertTitle, Box, Button, Card, CardContent, Checkbox, Chip, CircularProgress,
  Collapse, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle,
  Divider, IconButton, LinearProgress, MenuItem, Stack, Table, TableBody,
  TableCell, TableHead, TableRow, TextField, Typography,
} from "@mui/material";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import PrintIcon from "@mui/icons-material/Print";
import UndoIcon from "@mui/icons-material/Undo";
import ChangeCircleIcon from "@mui/icons-material/ChangeCircle";
import { Money } from "../../components/Money";
import { PermissionDenied } from "../../components/Guards";
import { useAsync } from "../../lib/useAsync";
import { useAuth } from "../../auth/AuthContext";
import { useWriteOnce } from "../../lib/writeOnce";
import { messageFor } from "../../api/errors";
import { sentenceFor } from "../../api/grossChange";
import { formatDate, formatDateRange, formatDayLong, todayInFarm } from "../../lib/dates";
import { formatMoney, formatQuantity } from "../../lib/money";
import { CORRECTION_GLOSS } from "../../lib/vocab";
import { payrollHtml } from "../documents/documents";
import { printDocument } from "../documents/print";
import type { PayMethod, Uuid } from "../../api/types";
import {
  checkPayRun, checkPassed, checkSettleRun, hasProvisional, isComplete, loadCrew,
  payApprovalOf, payCheckPassed, payrollRowsOf, payrollScopeOf, payrollTitleOf,
  runIsPartial, RunIncomplete, runPayments, runSettlements, settleApprovalOf, undoHandleOf,
  undoIsEmpty, undoRun, balanceCentsOf,
  type CrewCheck, type CrewMember, type PayApproval, type PayCheck, type PayrollRun,
  type RunRow, type RunScope, type SettleApproval, type UndoResult,
} from "./crew";

/** How the difference explanation writes its figures and dates. */
const FMT = { money: formatMoney, week: formatDayLong };

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

type Step = "settle" | "pay";

export function CrewPayrollPage() {
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const { data, error, denied, reload } = useAsync(() => loadCrew(), []);

  const [search, setSearch] = useState("");
  /** Who got unticked. By default the whole crew is in. */
  const [outOfSettle, setOutOfSettle] = useState<Set<Uuid>>(new Set());
  const [outOfPay, setOutOfPay] = useState<Set<Uuid>>(new Set());
  const [open, setOpen] = useState<Set<Uuid>>(new Set());
  const [method, setMethod] = useState<PayMethod>("efectivo");

  const [confirm, setConfirm] = useState<Step | null>(null);
  /**
   * How far the run has got. One state and not two, because checking and
   * writing are stretches of the SAME act: while either one is under way no
   * other payroll can be fired, and two independent flags end up leaving a gap
   * between them.
   */
  const [phase, setPhase] = useState<"checking" | Step | null>(null);
  const [settleDrift, setSettleDrift] = useState<CrewCheck | null>(null);
  const [payDrift, setPayDrift] = useState<PayCheck | null>(null);
  const [arrivals, setArrivals] = useState<CrewCheck["arrivals"]>([]);

  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [runError, setRunError] = useState<string | null>(null);

  const [askUndo, setAskUndo] = useState(false);
  const [undone, setUndone] = useState<UndoResult | null>(null);

  const { busy, run: runOnce, retire } = useWriteOnce();

  const crew: CrewMember[] = useMemo(() => data ?? [], [data]);

  /** THE WHOLE CREW, before filtering and before unticking. */
  const allSettle = useMemo(
    () => crew.map(settleApprovalOf).filter((a): a is SettleApproval => a !== null),
    [crew],
  );
  const allPay = useMemo(
    () => crew.map(payApprovalOf).filter((a): a is PayApproval => a !== null),
    [crew],
  );

  const matches = (name: string) => fold(name).includes(fold(search.trim()));
  const visibleSettle = allSettle.filter((a) => matches(a.name));
  const visiblePay = allPay.filter((a) => matches(a.name));
  const pickedSettle = visibleSettle.filter((a) => !outOfSettle.has(a.workerId));
  const pickedPay = visiblePay.filter((a) => !outOfPay.has(a.workerId));

  const settleTotal = pickedSettle.reduce((s, a) => s + a.grossCents, 0);
  const payTotal = pickedPay.reduce((s, a) => s + a.amountCents, 0);
  const settleQty = pickedSettle.reduce((s, a) => s + (a.quantity ?? 0), 0);
  const anyQty = pickedSettle.some((a) => a.quantity !== null);
  const unitLabel = pickedSettle.find((a) => a.unitLabel)?.unitLabel ?? null;
  const anyProvisional = pickedSettle.some(hasProvisional);

  /** Employees whose outstanding work could not be read. Cannot be approved. */
  const unreadable = crew.filter((m) => m.failure !== null);

  const undoHandle = undoHandleOf(runs);
  const canUndo = !undoIsEmpty(undoHandle);

  if (!can("money.pay")) return <PermissionDenied moduleName="correr la nómina" />;
  if (denied) return <PermissionDenied moduleName="correr la nómina" />;
  if (error) return <Alert severity="error">{error}</Alert>;

  /** The scope frozen with the approval: what the paper will own up to. */
  function scopeOf(step: Step): RunScope {
    const filters: string[] = [];
    if (search.trim() !== "") filters.push(`empleado contiene «${search.trim()}»`);
    const cents: number[] =
      step === "settle"
        ? allSettle.map((a) => a.grossCents)
        : allPay.map((a) => a.amountCents);
    return {
      filters,
      crewSize: cents.length,
      crewTotalCents: cents.reduce((s, c) => s + c, 0),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Step 1 — settle                                                   */
  /* ---------------------------------------------------------------- */

  async function doSettle() {
    const approvals = pickedSettle;
    if (approvals.length === 0) return;

    /**
     * The fact being written, named by everything it depends on. Two clicks
     * produce the same string and therefore the same ids; changing who gets
     * paid or how much produces another one, and then it is a different
     * payroll and not a retry the server could swallow.
     */
    const intent = [
      "payroll-settle",
      approvals.map((a) => `${a.workerId}:${a.grossCents}`).sort().join("+"),
    ].join("|");

    setRunError(null);
    setUndone(null);
    const scope = scopeOf("settle");

    /**
     * THE CHECK GOES INSIDE `runOnce`, and this is the part with a trick in
     * it. The temptation is to leave it outside —it is a read, not a write,
     * and there is nothing to protect while it reads. But the latch that stops
     * the second click is synchronous and lives INSIDE `run`: if the check
     * sits in front, both clicks go through it, and all it takes is for the
     * first run to finish before the second click's read comes back and there
     * are two payrolls. It is unlikely, and it is exactly the kind of unlikely
     * that happens on a Saturday with a bad connection. Inside, the second
     * click never even gets to ask.
     */
    const outcome = await runOnce(intent, async (mint) => {
      setPhase("checking");
      const check = await checkSettleRun(approvals);
      setArrivals(check.arrivals);
      if (!checkPassed(check)) {
        // Nothing written, and the approved figure is dead: retiring the ids
        // makes the next approval a new fact from end to end.
        retire(intent);
        setSettleDrift(check);
        return null;
      }

      setPhase("settle");
      const rows = await runSettlements(approvals, mint, "Nómina de cuadrilla");
      const run: PayrollRun = {
        step: "settle",
        rows,
        scope,
        method: null,
        at: new Date().toISOString(),
        complete: isComplete(rows),
        unitLabel,
      };
      // It stopped halfway: throwing is what keeps the ids so that
      // "Reintentar" is a real retry. See `RunIncomplete`.
      if (!run.complete) throw new RunIncomplete(rows);
      return run;
    }).catch((e: unknown) => {
      if (e instanceof RunIncomplete) {
        setConfirm(null);
        setRuns((prev) => [
          ...prev,
          {
            step: "settle",
            rows: e.rows,
            scope,
            method: null,
            at: new Date().toISOString(),
            complete: false,
            unitLabel,
          },
        ]);
      } else {
        setRunError(messageFor(e));
      }
      return { ran: false } as const;
    });

    setPhase(null);
    setConfirm(null);
    // `ran: false` is a second click the latch swallowed, or a failure already
    // reported above. `value === null` is the difference, which is already on
    // screen. In neither case is there a run to record.
    if (!outcome.ran || outcome.value === null) return;
    const finished = outcome.value;
    setRuns((prev) => [...prev, finished]);
    setOutOfSettle(new Set());
    reload();
  }

  /* ---------------------------------------------------------------- */
  /* Step 2 — pay                                                      */
  /* ---------------------------------------------------------------- */

  async function doPay() {
    const approvals = pickedPay;
    if (approvals.length === 0) return;

    const intent = [
      "payroll-pay",
      method,
      approvals.map((a) => `${a.workerId}:${a.amountCents}`).sort().join("+"),
    ].join("|");

    setRunError(null);
    setUndone(null);
    const scope = scopeOf("pay");

    const outcome = await runOnce(intent, async (mint) => {
      setPhase("checking");
      const check = await checkPayRun(approvals);
      if (!payCheckPassed(check)) {
        retire(intent);
        setPayDrift(check);
        return null;
      }

      setPhase("pay");
      const rows = await runPayments(approvals, method, mint, "Nómina de cuadrilla");
      const run: PayrollRun = {
        step: "pay",
        rows,
        scope,
        method,
        at: new Date().toISOString(),
        complete: isComplete(rows),
        unitLabel,
      };
      if (!run.complete) throw new RunIncomplete(rows);
      return run;
    }).catch((e: unknown) => {
      if (e instanceof RunIncomplete) {
        setConfirm(null);
        setRuns((prev) => [
          ...prev,
          {
            step: "pay",
            rows: e.rows,
            scope,
            method,
            at: new Date().toISOString(),
            complete: false,
            unitLabel,
          },
        ]);
      } else {
        setRunError(messageFor(e));
      }
      return { ran: false } as const;
    });

    setPhase(null);
    setConfirm(null);
    if (!outcome.ran || outcome.value === null) return;
    const finished = outcome.value;
    setRuns((prev) => [...prev, finished]);
    setOutOfPay(new Set());
    reload();
  }

  /* ---------------------------------------------------------------- */
  /* Undo                                                              */
  /* ---------------------------------------------------------------- */

  async function doUndo() {
    setAskUndo(false);
    setRunError(null);
    const intent = [
      "payroll-undo",
      undoHandle.payments.join("+"),
      undoHandle.settlements.join("+"),
    ].join("|");

    const outcome = await runOnce(intent, (mint) =>
      undoRun(undoHandle, "Nómina de cuadrilla deshecha", mint),
    ).catch((e: unknown) => {
      setRunError(messageFor(e));
      return { ran: false } as const;
    });

    if (!outcome.ran) return;
    setUndone(outcome.value);
    // Whatever is left to undo still stands; the rest no longer exists.
    // Putting the whole handle back would offer to undo what is already undone,
    // and that answers 409 and looks like a failure. Keep it only if something
    // failed.
    if (outcome.value.failures.length === 0) setRuns([]);
    reload();
  }

  /* ---------------------------------------------------------------- */
  /* The paper                                                         */
  /* ---------------------------------------------------------------- */

  function printRun(run: PayrollRun) {
    const ok = printDocument(
      payrollHtml({
        farmName: user?.farm.name ?? "Finca",
        title: payrollTitleOf(run),
        date: todayInFarm(user?.farm.timezone ?? "America/Bogota"),
        unit: run.unitLabel,
        scope: payrollScopeOf(run),
        rows: payrollRowsOf(run),
      }),
    );
    if (!ok) setRunError("No se pudo abrir la impresión. Revise el navegador.");
  }

  /** What the confirmation dialog lists, whichever step it came from. */
  const confirmRows =
    confirm === "settle"
      ? pickedSettle.map((a) => ({
          workerId: a.workerId,
          name: a.name,
          quantity: a.quantity,
          unitLabel: a.unitLabel,
          cents: a.grossCents,
        }))
      : pickedPay.map((a) => ({
          workerId: a.workerId,
          name: a.name,
          quantity: null as number | null,
          unitLabel: null as string | null,
          cents: a.amountCents,
        }));

  const toggle = (set: Set<Uuid>, id: Uuid, apply: (s: Set<Uuid>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  const loading = data === null;

  return (
    <Box>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ sm: "flex-start" }}
        spacing={2}
        sx={{ mb: 2 }}
      >
        <Box>
          <Typography variant="h1">Nómina de cuadrilla</Typography>
          <Typography color="text.secondary" sx={{ maxWidth: 760 }}>
            Liquidar congela la semana; pagar entrega el efectivo.
          </Typography>
        </Box>
      </Stack>

      {runError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setRunError(null)}>
          {runError}
        </Alert>
      )}

      {undone && (
        <Alert
          severity={undone.failures.length ? "warning" : "success"}
          sx={{ mb: 2 }}
          onClose={() => setUndone(null)}
        >
          <AlertTitle>Nómina deshecha</AlertTitle>
          Se anularon <strong>{undone.paymentsReversed}</strong>{" "}
          {undone.paymentsReversed === 1 ? "pago" : "pagos"} y se anularon{" "}
          <strong>{undone.settlementsVoided}</strong>{" "}
          {undone.settlementsVoided === 1 ? "liquidación" : "liquidaciones"}.
          {undone.alreadyUndone > 0 && (
            <> {undone.alreadyUndone} ya estaban deshechas.</>
          )}
          {undone.failures.length > 0 && (
            <>
              {" "}
              <strong>{undone.failures.length} no se pudieron deshacer:</strong>{" "}
              {undone.failures.join("; ")}. Quedan en el libro y hay que corregirlas a
              mano desde la ficha del empleado.
            </>
          )}
        </Alert>
      )}

      {unreadable.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          No se pudo leer lo pendiente de{" "}
          <strong>
            {unreadable.length} {unreadable.length === 1 ? "empleado" : "empleados"}
          </strong>{" "}
          ({unreadable.map((m) => m.name).join(", ")}). No entran en esta nómina: no se
          aprueba una cifra que no se pudo ver.{" "}
          <Button size="small" color="inherit" onClick={reload}>
            Volver a intentar
          </Button>
        </Alert>
      )}

      {arrivals.length > 0 && (
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => setArrivals([])}>
          Llegó trabajo nuevo mientras revisaba:{" "}
          {arrivals
            .map((a) => `${a.name} (${a.lines.length})`)
            .join(", ")}
          . <strong>No entra en esta corrida</strong> — la liquidación toma exactamente
          las labores que usted aprobó — y queda pendiente para la próxima.
        </Alert>
      )}

      <TextField
        label="Buscar por empleado"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        size="small"
        sx={{ minWidth: 280, mb: 2 }}
      />

      {search.trim() !== "" && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => setSearch("")}>
              Quitar el filtro
            </Button>
          }
        >
          Está viendo <strong>{visibleSettle.length}</strong> de{" "}
          <strong>{allSettle.length}</strong> por liquidar y{" "}
          <strong>{visiblePay.length}</strong> de <strong>{allPay.length}</strong> por
          pagar. Lo que corra ahora es de esa parte de la cuadrilla, no de la finca
          entera — y la planilla lo dirá impreso.
        </Alert>
      )}

      {loading && <LinearProgress sx={{ mb: 2 }} />}

      {/* ── STEP 1 ─────────────────────────────────────────────────── */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Stack
            direction={{ xs: "column", md: "row" }}
            justifyContent="space-between"
            alignItems={{ md: "center" }}
            spacing={2}
            sx={{ mb: 2 }}
          >
            <Box>
              <Typography variant="h3">1 · Liquidar la semana</Typography>
              <Typography variant="body2" color="text.secondary">
                Congela lo pendiente al precio que tiene hoy y escribe en el libro lo
                que ganó cada persona. Todavía no sale plata.
              </Typography>
            </Box>
            <Box sx={{ textAlign: { md: "right" } }}>
              <Typography variant="overline" color="text.secondary">
                Bruto a liquidar
              </Typography>
              {loading ? (
                <Typography color="text.secondary">Cargando…</Typography>
              ) : (
                <Money cents={settleTotal} variant="big" />
              )}
              <Typography variant="body2" color="text.secondary">
                {pickedSettle.length}{" "}
                {pickedSettle.length === 1 ? "persona" : "personas"}
                {anyQty && unitLabel
                  ? ` · ${formatQuantity(settleQty)} ${unitLabel}`
                  : ""}
              </Typography>
            </Box>
          </Stack>

          {anyProvisional && (
            <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>
              Hay labores marcadas <strong>provisional</strong>: se pagan al precio de
              la semana, que se fija al cerrar la semana. Liquidar es lo que las fija.
              Si ese precio cambia antes de que usted firme, esta pantalla se lo dirá y
              no registrará nada.
            </Alert>
          )}

          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell />
                <TableCell>Empleado</TableCell>
                <TableCell align="right">Labores</TableCell>
                <TableCell align="right">Cantidad</TableCell>
                <TableCell align="right">Saldo hoy</TableCell>
                <TableCell align="right">Bruto</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visibleSettle.map((a) => {
                const member = crew.find((m) => m.worker.id === a.workerId);
                const balance = member ? balanceCentsOf(member) : null;
                const isOpen = open.has(a.workerId);
                return (
                  <Fragment key={a.workerId}>
                    <TableRow hover>
                      <TableCell padding="checkbox">
                        <Checkbox
                          checked={!outOfSettle.has(a.workerId)}
                          onChange={() =>
                            toggle(outOfSettle, a.workerId, setOutOfSettle)
                          }
                          inputProps={{ "aria-label": `Incluir a ${a.name}` }}
                        />
                      </TableCell>
                      <TableCell padding="checkbox">
                        <IconButton
                          size="small"
                          aria-label={`Ver el detalle de ${a.name}`}
                          onClick={() => toggle(open, a.workerId, setOpen)}
                        >
                          {isOpen ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
                        </IconButton>
                      </TableCell>
                      <TableCell sx={{ fontWeight: 600 }}>
                        {a.name}
                        {hasProvisional(a) && (
                          <Chip
                            size="small"
                            color="warning"
                            variant="outlined"
                            label="provisional"
                            sx={{ ml: 1, height: 20, fontSize: "0.68rem" }}
                          />
                        )}
                      </TableCell>
                      <TableCell align="right">{a.lines.length}</TableCell>
                      <TableCell align="right">
                        {a.quantity === null
                          ? "—"
                          : `${formatQuantity(a.quantity)} ${a.unitLabel ?? ""}`}
                      </TableCell>
                      <TableCell align="right">
                        {/* Null is null. A "$0" here would say "owed nothing". */}
                        {balance === null ? (
                          <Typography variant="body2" color="text.secondary">
                            no se pudo leer
                          </Typography>
                        ) : (
                          <Money cents={balance} variant="small" signed colored />
                        )}
                      </TableCell>
                      <TableCell align="right">
                        <Money cents={a.grossCents} variant="small" />
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell sx={{ py: 0, border: 0 }} colSpan={7}>
                        <Collapse in={isOpen} unmountOnExit>
                          <Box sx={{ py: 1.5, pl: 6 }}>
                            <Table size="small">
                              <TableHead>
                                <TableRow>
                                  <TableCell>Actividad</TableCell>
                                  <TableCell>Fecha</TableCell>
                                  <TableCell align="right">Cantidad</TableCell>
                                  <TableCell align="right">Precio</TableCell>
                                  <TableCell align="right">Valor</TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {a.lines.map((l) => (
                                  <TableRow key={l.id}>
                                    <TableCell>
                                      {l.activityName}
                                      {l.rateSource === "weekly_price" && (
                                        <Chip
                                          size="small"
                                          color="warning"
                                          variant="outlined"
                                          label="provisional"
                                          sx={{ ml: 1, height: 18, fontSize: "0.62rem" }}
                                        />
                                      )}
                                    </TableCell>
                                    <TableCell>
                                      {formatDateRange(l.dateFrom, l.dateTo)}
                                    </TableCell>
                                    <TableCell align="right">
                                      {l.unitLabel
                                        ? `${formatQuantity(l.quantity)} ${l.unitLabel}`
                                        : "contrato"}
                                    </TableCell>
                                    <TableCell align="right">
                                      {`${formatMoney(l.rateCents)}${
                                        l.unitLabel ? ` / ${l.unitLabel}` : ""
                                      }`}
                                    </TableCell>
                                    <TableCell align="right">
                                      <Money cents={l.amountCents} variant="small" />
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                            <Button
                              size="small"
                              sx={{ mt: 1 }}
                              onClick={() => navigate(`/empleados/${a.workerId}/pagar`)}
                            >
                              Pagarle aparte
                            </Button>
                          </Box>
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                );
              })}
              {!loading && visibleSettle.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} sx={{ color: "text.secondary" }}>
                    {allSettle.length === 0
                      ? "No hay nada pendiente de liquidar en la finca."
                      : "Nadie coincide con el filtro."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          <Stack direction="row" justifyContent="flex-end" sx={{ mt: 2 }}>
            <Button
              variant="contained"
              size="large"
              disabled={busy || pickedSettle.length === 0}
              onClick={() => setConfirm("settle")}
            >
              Revisar y liquidar · {formatMoney(settleTotal)}
            </Button>
          </Stack>
        </CardContent>
      </Card>

      {/* ── STEP 2 ─────────────────────────────────────────────────── */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Stack
            direction={{ xs: "column", md: "row" }}
            justifyContent="space-between"
            alignItems={{ md: "center" }}
            spacing={2}
            sx={{ mb: 2 }}
          >
            <Box>
              <Typography variant="h3">2 · Pagar la nómina</Typography>
              <Typography variant="body2" color="text.secondary">
                Todo el que tiene saldo a favor, venga de esta semana o de una anterior.
                Esta lista se lee del servidor: si cierra el navegador entre los dos
                pasos, sigue aquí.
              </Typography>
            </Box>
            <Box sx={{ textAlign: { md: "right" } }}>
              <Typography variant="overline" color="text.secondary">
                A entregar
              </Typography>
              {loading ? (
                <Typography color="text.secondary">Cargando…</Typography>
              ) : (
                <Money cents={payTotal} variant="big" />
              )}
              <Typography variant="body2" color="text.secondary">
                {pickedPay.length} {pickedPay.length === 1 ? "persona" : "personas"}
              </Typography>
            </Box>
          </Stack>

          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>Empleado</TableCell>
                <TableCell>Documento</TableCell>
                <TableCell>Último movimiento</TableCell>
                <TableCell align="right">A entregar</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visiblePay.map((a) => {
                const member = crew.find((m) => m.worker.id === a.workerId);
                return (
                  <TableRow key={a.workerId} hover>
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={!outOfPay.has(a.workerId)}
                        onChange={() => toggle(outOfPay, a.workerId, setOutOfPay)}
                        inputProps={{ "aria-label": `Pagar a ${a.name}` }}
                      />
                    </TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{a.name}</TableCell>
                    <TableCell>{a.documentNumber ?? "—"}</TableCell>
                    <TableCell>
                      {member?.balance?.lastMovementOn
                        ? formatDate(member.balance.lastMovementOn)
                        : "—"}
                    </TableCell>
                    <TableCell align="right">
                      <Money cents={a.amountCents} variant="small" />
                    </TableCell>
                  </TableRow>
                );
              })}
              {!loading && visiblePay.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} sx={{ color: "text.secondary" }}>
                    {allPay.length === 0
                      ? "Nadie tiene saldo a favor. Liquide primero."
                      : "Nadie coincide con el filtro."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          <Stack
            direction={{ xs: "column", sm: "row" }}
            justifyContent="flex-end"
            alignItems={{ sm: "center" }}
            spacing={2}
            sx={{ mt: 2 }}
          >
            <TextField
              select
              label="Forma de pago"
              value={method}
              onChange={(e) => setMethod(e.target.value as PayMethod)}
              size="small"
              sx={{ minWidth: 200 }}
            >
              <MenuItem value="efectivo">Efectivo</MenuItem>
              <MenuItem value="transferencia">Transferencia</MenuItem>
              <MenuItem value="otro">Otro</MenuItem>
            </TextField>
            <Button
              variant="contained"
              size="large"
              disabled={busy || pickedPay.length === 0}
              onClick={() => setConfirm("pay")}
            >
              Revisar y pagar · {formatMoney(payTotal)}
            </Button>
          </Stack>
        </CardContent>
      </Card>

      {/* ── THE REPORT ─────────────────────────────────────────────── */}
      {runs.map((run, i) => (
        <RunReport
          key={`${run.step}-${run.at}-${i}`}
          run={run}
          onPrint={() => printRun(run)}
          onRetry={run.step === "settle" ? doSettle : doPay}
          busy={busy}
        />
      ))}

      {canUndo && (
        <Card variant="outlined" sx={{ mb: 3, borderColor: "warning.main" }}>
          <CardContent>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              justifyContent="space-between"
              alignItems={{ sm: "center" }}
              spacing={2}
            >
              <Box>
                <Typography variant="h3">Deshacer la nómina</Typography>
                <Typography variant="body2" color="text.secondary">
                  Mientras esta pantalla siga abierta. Después, cada documento se
                  deshace por separado desde Liquidaciones y desde la ficha del
                  empleado.
                </Typography>
              </Box>
              <Button
                variant="outlined"
                color="warning"
                startIcon={<UndoIcon />}
                disabled={busy}
                onClick={() => setAskUndo(true)}
              >
                Deshacer
              </Button>
            </Stack>
          </CardContent>
        </Card>
      )}

      {/* ── CONFIRM: SEE IT BEFORE YOU SIGN IT ─────────────────────── */}
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          {confirm === "settle"
            ? `Liquidar a ${pickedSettle.length} ${pickedSettle.length === 1 ? "persona" : "personas"}`
            : `Entregar ${formatMoney(payTotal)} a ${pickedPay.length} ${pickedPay.length === 1 ? "persona" : "personas"}`}
        </DialogTitle>
        <DialogContent dividers>
          <DialogContentText component="div" sx={{ mb: 2 }}>
            {confirm === "settle" ? (
              <>
                Esto escribe una liquidación por persona y deja anotado en el libro lo
                que ganó.{" "}
                <strong>No entrega plata todavía</strong>: eso es el paso 2.
              </>
            ) : (
              <>
                Esto escribe un pago por persona en el libro. Los pagos{" "}
                <strong>no se editan</strong>: si queda mal, se corrige con{" "}
                {CORRECTION_GLOSS}
              </>
            )}
          </DialogContentText>

          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Empleado</TableCell>
                {confirm === "settle" && <TableCell align="right">Cantidad</TableCell>}
                <TableCell align="right">
                  {confirm === "settle" ? "Bruto" : "A entregar"}
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {confirmRows.map((a) => (
                <TableRow key={a.workerId}>
                  <TableCell>{a.name}</TableCell>
                  {confirm === "settle" && (
                    <TableCell align="right">
                      {a.quantity === null
                        ? "—"
                        : `${formatQuantity(a.quantity)} ${a.unitLabel ?? ""}`}
                    </TableCell>
                  )}
                  <TableCell align="right">
                    <Money cents={a.cents} variant="small" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Divider sx={{ my: 2 }} />
          <Stack direction="row" justifyContent="space-between" alignItems="baseline">
            <Typography variant="h3">Total</Typography>
            <Money cents={confirm === "settle" ? settleTotal : payTotal} variant="big" />
          </Stack>

          {confirm === "settle" && anyProvisional && (
            <Alert severity="warning" variant="outlined" sx={{ mt: 2 }}>
              Parte de este bruto está al precio de la semana. Liquidar es lo que lo
              fija: a partir de aquí deja de ser provisional.
            </Alert>
          )}
          {search.trim() !== "" && (
            <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
              Hay un filtro puesto («{search.trim()}»). Esto no es la cuadrilla entera, y
              la planilla saldrá marcada como parcial.
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setConfirm(null)}>
            Ahora no
          </Button>
          <Button
            variant="contained"
            disabled={busy}
            startIcon={phase === "checking" ? <CircularProgress size={16} /> : undefined}
            onClick={confirm === "settle" ? doSettle : doPay}
          >
            {phase === "checking"
              ? "Comprobando que nada se movió…"
              : confirm === "settle"
                ? "Liquidar"
                : `Pagar ${formatMoney(payTotal)}`}
          </Button>
        </DialogActions>
      </Dialog>

      {(phase === "settle" || phase === "pay") && (
        <Dialog open maxWidth="xs" fullWidth>
          <DialogTitle>
            {phase === "settle" ? "Liquidando…" : "Registrando los pagos…"}
          </DialogTitle>
          <DialogContent>
            <LinearProgress sx={{ my: 2 }} />
            <DialogContentText>
              Una escritura por persona, en orden. No cierre esta pestaña.
            </DialogContentText>
          </DialogContent>
        </Dialog>
      )}

      <SettleDriftDialog
        check={settleDrift}
        onReview={() => {
          setSettleDrift(null);
          setOutOfSettle(new Set());
          reload();
        }}
      />

      <PayDriftDialog
        check={payDrift}
        onReview={() => {
          setPayDrift(null);
          setOutOfPay(new Set());
          reload();
        }}
      />

      {/* ── UNDO: SAY WHAT IT WILL UNDO BEFORE DOING IT ────────────── */}
      <Dialog open={askUndo} onClose={() => setAskUndo(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Deshacer la nómina</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            Se van a reversar <strong>{undoHandle.payments.length}</strong>{" "}
            {undoHandle.payments.length === 1 ? "pago" : "pagos"} y a anular{" "}
            <strong>{undoHandle.settlements.length}</strong>{" "}
            {undoHandle.settlements.length === 1 ? "liquidación" : "liquidaciones"}.
            <Box sx={{ mt: 2 }}>
              Primero los pagos y después las liquidaciones: anular escribe su propia
              corrección de lo ganado, y al revés quedaría un pago en pie contra algo
              que ya no está.
            </Box>
            <Box sx={{ mt: 2 }}>
              Nada se borra. Quedan la liquidación anulada y la corrección del pago, que
              es como el libro cuenta lo que pasó.
            </Box>
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setAskUndo(false)}>
            Ahora no
          </Button>
          <Button variant="contained" color="warning" disabled={busy} onClick={doUndo}>
            Deshacer
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/* The run report                                                      */
/* ------------------------------------------------------------------ */

const STATUS_LABEL: Record<RunRow["status"], string> = {
  done: "entró",
  refused: "no entró",
  skipped: "sin intentar",
};

function RunReport({
  run,
  onPrint,
  onRetry,
  busy,
}: {
  run: PayrollRun;
  onPrint: () => void;
  onRetry: () => void;
  busy: boolean;
}) {
  const done = run.rows.filter((r) => r.status === "done");
  const total = done.reduce(
    (s, r) => s + (run.step === "settle" ? (r.grossCents ?? 0) : (r.paidCents ?? 0)),
    0,
  );
  const partial = runIsPartial(run);

  return (
    <Card sx={{ mb: 3 }} variant="outlined">
      <CardContent>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          justifyContent="space-between"
          alignItems={{ sm: "center" }}
          spacing={2}
          sx={{ mb: 2 }}
        >
          <Box>
            <Typography variant="h3">
              {run.step === "settle" ? "Liquidación de cuadrilla" : "Nómina pagada"}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {done.length} de {run.rows.length}{" "}
              {run.rows.length === 1 ? "persona" : "personas"} ·{" "}
              {formatMoney(total)}
              {run.method ? ` · ${run.method}` : ""}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            {!run.complete && (
              <Button variant="outlined" disabled={busy} onClick={onRetry}>
                Reintentar
              </Button>
            )}
            <Button variant="contained" startIcon={<PrintIcon />} onClick={onPrint}>
              {partial ? "Planilla (parcial)" : "Planilla"}
            </Button>
          </Stack>
        </Stack>

        {!run.complete && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>La corrida se detuvo</AlertTitle>
            Se paró en el primer rechazo, a propósito: si el mundo se movió a mitad de
            la nómina, seguir sería firmar cifras que ya nadie ha mirado. Lo que sí
            entró está escrito y se puede deshacer. <strong>Reintentar</strong> reenvía
            los mismos identificadores, así que lo ya escrito no se escribe dos veces.
          </Alert>
        )}

        {partial && (
          <Alert severity="info" sx={{ mb: 2 }}>
            Esta planilla saldrá marcada <strong>PARCIAL</strong>:{" "}
            {payrollScopeOf(run).filters.join("; ")}.
          </Alert>
        )}

        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Empleado</TableCell>
              <TableCell align="right">
                {run.step === "settle" ? "Bruto" : "Entregado"}
              </TableCell>
              {run.step === "pay" && <TableCell align="right">Saldo después</TableCell>}
              <TableCell>Estado</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {run.rows.map((r) => (
              <TableRow key={r.workerId}>
                <TableCell sx={{ fontWeight: r.status === "done" ? 600 : 400 }}>
                  {r.name}
                </TableCell>
                <TableCell align="right">
                  <Money
                    cents={(run.step === "settle" ? r.grossCents : r.paidCents) ?? 0}
                    variant="small"
                  />
                </TableCell>
                {run.step === "pay" && (
                  <TableCell align="right">
                    {/* Null when the write never happened: there is no later
                        balance to read, and a "$0" would say they went home
                        square with everybody. */}
                    {r.balanceAfterCents === null ? (
                      "—"
                    ) : (
                      <Money cents={r.balanceAfterCents} variant="small" />
                    )}
                  </TableCell>
                )}
                <TableCell>
                  <Chip
                    size="small"
                    variant="outlined"
                    color={
                      r.status === "done"
                        ? "success"
                        : r.status === "refused"
                          ? "error"
                          : "default"
                    }
                    label={STATUS_LABEL[r.status]}
                  />
                  {r.reason && (
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      {r.reason}
                    </Typography>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* The differences                                                     */
/* ------------------------------------------------------------------ */

/**
 * This is not an error box, for the same reason as in `PayWorkerPage`: what
 * happened is not that something failed, it is that the farm owes a different
 * amount, and whoever signs has to see the new one before approving it.
 *
 * `onClose` is not wired up and the escape key is disabled: every way out goes
 * through "Volver a revisar", which throws away the expired approval and reads
 * again. From here there is no path at all to a write.
 */
function SettleDriftDialog({
  check,
  onReview,
}: {
  check: CrewCheck | null;
  onReview: () => void;
}) {
  const n = (check?.drifts.length ?? 0) + (check?.unreadable.length ?? 0);
  return (
    <Dialog open={check !== null} disableEscapeKeyDown maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <ChangeCircleIcon color="warning" />
        Cambió algo mientras revisaba
      </DialogTitle>
      <DialogContent dividers>
        <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>
          <AlertTitle>
            No se liquidó a nadie, y no se pagó a nadie.
          </AlertTitle>
          {n === 1
            ? "A una persona de la corrida le cambió la cifra entre que usted la miró y ahora. La nómina entera se detuvo antes de escribir nada."
            : `A ${n} personas de la corrida les cambió la cifra entre que usted las miró y ahora. La nómina entera se detuvo antes de escribir nada.`}
        </Alert>

        {check?.drifts.map((d) => (
          <Box key={d.workerId} sx={{ mb: 3 }}>
            <Typography variant="h3">{d.name}</Typography>
            <Typography sx={{ mb: 1 }}>{sentenceFor(d, FMT)}</Typography>
            <Stack
              direction="row"
              spacing={2}
              divider={<Divider orientation="vertical" flexItem />}
            >
              <Box>
                <Typography variant="overline" color="text.secondary">
                  Aprobado
                </Typography>
                <Money cents={d.beforeCents} variant="small" />
              </Box>
              <Box>
                <Typography variant="overline" color="text.secondary">
                  Ahora
                </Typography>
                <Money cents={d.afterCents} variant="small" />
              </Box>
              <Box>
                <Typography variant="overline" color="text.secondary">
                  Diferencia
                </Typography>
                <Money cents={d.deltaCents} signed colored variant="small" />
              </Box>
            </Stack>
          </Box>
        ))}

        {check && check.unreadable.length > 0 && (
          <Alert severity="error" variant="outlined">
            <AlertTitle>No se pudo volver a leer</AlertTitle>
            {check.unreadable.map((u) => `${u.name}: ${u.reason}`).join(" · ")}
            <Box sx={{ mt: 1 }}>
              Sin poder confirmar la cifra no se firma. Es la misma regla que arriba,
              aplicada a no saber en vez de a saber que cambió.
            </Box>
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="contained" onClick={onReview} autoFocus>
          Volver a revisar
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function PayDriftDialog({
  check,
  onReview,
}: {
  check: PayCheck | null;
  onReview: () => void;
}) {
  return (
    <Dialog open={check !== null} disableEscapeKeyDown maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <ChangeCircleIcon color="warning" />
        El saldo cambió mientras revisaba
      </DialogTitle>
      <DialogContent dividers>
        <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>
          <AlertTitle>No se pagó a nadie.</AlertTitle>
          Alguien de la corrida ya no tiene el saldo que usted aprobó — un anticipo
          entregado en el lote, un descuento, un pago hecho desde el teléfono. Entregar
          la cifra vieja sería pagar de más o dejar la cuenta abierta sin decirlo.
        </Alert>
        {check && check.drifts.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Empleado</TableCell>
                <TableCell align="right">Aprobado</TableCell>
                <TableCell align="right">Saldo ahora</TableCell>
                <TableCell align="right">Diferencia</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {check.drifts.map((d) => (
                <TableRow key={d.workerId}>
                  <TableCell sx={{ fontWeight: 600 }}>{d.name}</TableCell>
                  <TableCell align="right">
                    <Money cents={d.beforeCents} variant="small" />
                  </TableCell>
                  <TableCell align="right">
                    <Money cents={d.afterCents} variant="small" />
                  </TableCell>
                  <TableCell align="right">
                    <Money cents={d.deltaCents} signed colored variant="small" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {check && check.unreadable.length > 0 && (
          <Alert severity="error" variant="outlined" sx={{ mt: 2 }}>
            No se pudo volver a leer el saldo de{" "}
            {check.unreadable.map((u) => u.name).join(", ")}.
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="contained" onClick={onReview} autoFocus>
          Volver a revisar
        </Button>
      </DialogActions>
    </Dialog>
  );
}
