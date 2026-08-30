/**
 * ── THE WEEK'S PRICE PER KILO ────────────────────────────────────────────
 *
 * `PUT /v1/prices/weeks/{monday}` has existed in the client since sprint 1 and
 * NO screen called it. The console knew how to read the week's price — the
 * work-item form shows it, harvest uses it, settlement freezes it — and did
 * not know how to set it. It is the most ordinary task a coffee farm owner has
 * during harvest, and from here it was impossible.
 *
 * And looking for it was a trap. Whoever went hunting for the field ended up
 * in Activities, pressed "Precio fijo" —which does have a price box— typed 900
 * and saved. That does not raise the week's price: it changes the PAY MODE of
 * all picking and disconnects it from the weekly price the phone still uses.
 * Nothing warned them. That trap is closed in `ActivityFormDialog`; this is
 * the other half: the field, where people look for it.
 *
 * ── WHY A SCREEN AND NOT A FIELD IN SETTINGS ─────────────────────────────
 *
 * Because the week's price is not a setting, it is a weekly fact with a date.
 * It has a history, it is set every Monday, and changing it moves money that
 * has not been settled yet. A lone field between the timezone and the currency
 * says none of that.
 *
 * ── WHAT IT MOVES, SAID BEFORE IT MOVES ──────────────────────────────────
 *
 * Changing a week's price reprices ALL of that week's picking that has not
 * been settled yet — that is literally what it exists for. What is already
 * settled is not touched: the settlement froze its price, and that is the
 * deal. Before writing anything, this screen says how many work items move
 * and from how much to how much, with the same pattern as the crew payroll:
 * "Revisar y…", and a confirmation that shows the figures.
 */
import { useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent,
  DialogContentText, Divider, DialogTitle, MenuItem, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, TextField, Typography,
} from "@mui/material";
import PriceChangeIcon from "@mui/icons-material/PriceChange";
import { Money } from "../../components/Money";
import { PermissionDenied } from "../../components/Guards";
import { useAsync } from "../../lib/useAsync";
import { useWriteOnce } from "../../lib/writeOnce";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { addDays, formatWeekRange, mondayOf, parseDay, todayInFarm, weekTag } from "../../lib/dates";
import { amountCents, formatMoney, formatQuantity, parseMoneyInput } from "../../lib/money";
import type { WorkRecord } from "../../api/types";

/** How many Mondays back we offer. A harvest is corrected, not rewritten. */
const WEEKS_BACK = 8;

const sundayOf = (monday: string) => addDays(parseDay(monday), 6).toISOString().slice(0, 10);

export function WeekPricePage() {
  const { user, can } = useAuth();
  const timezone = user?.farm?.timezone ?? "America/Bogota";
  const today = todayInFarm(timezone);
  const thisMonday = mondayOf(today);

  const mondays = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < WEEKS_BACK; i++) {
      out.push(addDays(parseDay(thisMonday), -7 * i).toISOString().slice(0, 10));
    }
    return out;
  }, [thisMonday]);

  const [monday, setMonday] = useState(thisMonday);
  const [draft, setDraft] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState<{ monday: string; cents: number } | null>(null);
  const { busy, run: runOnce } = useWriteOnce();
  const [tick, setTick] = useState(0);

  /**
   * One load with all three reads, so that "loading" and "could not" are
   * distinct states and not a shared zero. Work items are asked for only for
   * the chosen week: that is all a price change can move.
   */
  const { data, error, denied } = useAsync(async () => {
    const [price, farm, records] = await Promise.all([
      api.weekPrice(monday),
      api.getFarm().catch(() => null),
      api
        .listWorkRecords({ status: "active", from: monday, to: sundayOf(monday) })
        .catch(() => null),
    ]);
    return { price, farm, records };
  }, [monday, tick]);

  /** The previous weeks' prices, for the table below. */
  const { data: history } = useAsync(
    async () =>
      Promise.all(
        mondays.map(async (m) => ({
          monday: m,
          cents: await api.weekPrice(m).then((p) => p.costPerUnitCents).catch(() => null),
        })),
      ),
    [mondays, tick],
  );

  if (denied) return <PermissionDenied moduleName="ver el precio de la semana" />;
  if (!can("config.prices")) return <PermissionDenied moduleName="fijar el precio de la semana" />;

  const currentCents = data?.price.costPerUnitCents ?? null;
  const basePriceCents = data?.farm?.priceCents ?? null;
  /**
   * The API does not say whether the price came from the week's own row or
   * from the farm's base price — `GET` returns `COALESCE(override, base)`.
   * Which one it is cannot be asserted, so the screen only points out that
   * they match, which is a fact, instead of inventing the origin.
   */
  const sameAsBase = currentCents !== null && basePriceCents !== null && currentCents === basePriceCents;

  const newCents = parseMoneyInput(draft);

  /**
   * That week's picking that is still paid at the week's price.
   *
   * `estimatedAmountCents !== null` is in the predicate rather than assumed:
   * the server withholds every figure of money from a session that may not
   * read prices, and this screen adds those figures up to show what changing
   * the price would cost. A row whose amount we cannot see cannot be part of
   * that arithmetic — and it never is in practice, because reaching this
   * screen at all requires `money.read`. Saying it in the type is what keeps
   * the next reader from having to know that.
   */
  const movable = (data?.records ?? []).filter(
    (r): r is WorkRecord & { estimatedAmountCents: number } =>
      !r.settled &&
      r.amountIsEstimate === true &&
      r.unitLabel !== null &&
      r.estimatedAmountCents !== null,
  );
  const frozen = (data?.records ?? []).filter((r) => r.settled).length;
  const beforeCents = movable.reduce((a, r) => a + r.estimatedAmountCents, 0);
  const afterCents =
    newCents === null ? 0 : movable.reduce((a, r) => a + amountCents(r.quantity, newCents), 0);
  const movableKg = movable
    .filter((r) => r.unitLabel === "kg")
    .reduce((a, r) => a + r.quantity, 0);

  function review() {
    setSaveError(null);
    if (newCents === null) {
      setFieldError("Escriba el precio en pesos. Por ejemplo: 900");
      return;
    }
    if (newCents <= 0) {
      setFieldError("El precio tiene que ser mayor que cero.");
      return;
    }
    setFieldError(null);
    setConfirming(true);
  }

  async function save() {
    if (newCents === null) return;
    const outcome = await runOnce(`precio|${monday}|${newCents}`, () =>
      api.setWeekPrice(monday, newCents),
    ).catch((e: unknown) => {
      setSaveError(messageFor(e));
      return { ran: false } as const;
    });
    setConfirming(false);
    if (!outcome.ran) return;
    setSaved({ monday, cents: outcome.value.costPerUnitCents });
    setDraft("");
    setTick((t) => t + 1);
  }

  return (
    <Box>
      <Typography variant="h1" gutterBottom>
        Precio del kilo
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3, maxWidth: 720 }}>
        Lo que la finca paga por kilo recogido en una semana. Es el mismo precio que usa
        el teléfono, y el que se le fija a la recolección cuando usted liquida.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          No se pudo consultar el precio de la semana: {error}. Ninguna cifra de esta
          pantalla se pudo leer — y ninguna de ellas es cero.
        </Alert>
      )}

      {saved && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSaved(null)}>
          El kilo de la semana del <strong>{formatWeekRange(saved.monday)}</strong> queda
          en <strong>{formatMoney(saved.cents)}</strong>. La recolección de esa semana que
          todavía no se ha liquidado ya vale a este precio.
        </Alert>
      )}

      {saveError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setSaveError(null)}>
          {saveError}
        </Alert>
      )}

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            alignItems={{ sm: "center" }}
            sx={{ mb: 2 }}
          >
            <TextField
              select
              label="Semana"
              value={monday}
              onChange={(e) => {
                setMonday(e.target.value);
                setDraft("");
                setFieldError(null);
                setSaved(null);
              }}
              size="small"
              sx={{ minWidth: 260 }}
            >
              {mondays.map((m) => (
                <MenuItem key={m} value={m}>
                  {formatWeekRange(m)}
                  {weekTag(m, today) ? ` · ${weekTag(m, today)!.toLowerCase()}` : ""}
                </MenuItem>
              ))}
            </TextField>
            {weekTag(monday, today) && (
              <Chip size="small" color="primary" variant="outlined" label={weekTag(monday, today)} />
            )}
          </Stack>

          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={4}
            alignItems={{ md: "flex-end" }}
          >
            <Box>
              <Typography variant="overline" color="text.secondary">
                Se está pagando
              </Typography>
              {data === null ? (
                <Typography color="text.secondary">Cargando…</Typography>
              ) : currentCents === null ? (
                <Typography variant="h1" sx={{ fontSize: "1.9rem", color: "text.disabled" }}>
                  —
                </Typography>
              ) : (
                <Stack direction="row" alignItems="baseline" spacing={0.75}>
                  <Money cents={currentCents} variant="big" />
                  <Typography color="text.secondary">por kilo</Typography>
                </Stack>
              )}
              {sameAsBase && (
                <Typography variant="caption" color="text.secondary" component="div">
                  Igual al precio base de la finca. Si no ha fijado el de esta semana, es
                  éste el que se está usando.
                </Typography>
              )}
            </Box>

            <Stack direction="row" spacing={1} alignItems="flex-start">
              <TextField
                label="Precio nuevo por kilo"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setFieldError(null);
                }}
                error={!!fieldError}
                helperText={fieldError ?? "En pesos. Por ejemplo: 900"}
                size="medium"
                inputMode="numeric"
                sx={{ minWidth: 220 }}
              />
              {/* "Revisar y…": the button does not write, it shows what would move. */}
              <Button
                variant="contained"
                size="large"
                startIcon={<PriceChangeIcon />}
                disabled={busy || draft.trim() === ""}
                onClick={review}
                sx={{ height: 56 }}
              >
                Revisar y fijar
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h3" gutterBottom>
            Qué se movería en la semana del {formatWeekRange(monday)}
          </Typography>
          {data === null ? (
            <Typography color="text.secondary">Cargando…</Typography>
          ) : data.records === null ? (
            <Alert severity="warning" variant="outlined">
              No se pudieron consultar las labores de esta semana, así que no se puede
              decir cuánta recolección movería el cambio. <strong>No es ninguna.</strong>{" "}
              Puede fijar el precio igual: el servidor reprecia lo que corresponda.
            </Alert>
          ) : (
            <Stack spacing={1}>
              <Typography>
                <strong>{movable.length}</strong>{" "}
                {movable.length === 1 ? "labor de recolección" : "labores de recolección"} sin
                liquidar
                {movableKg > 0 ? ` · ${formatQuantity(movableKg)} kg` : ""} — hoy valen{" "}
                <Money cents={beforeCents} variant="small" />.
              </Typography>
              <Typography color="text.secondary" variant="body2">
                {frozen === 0
                  ? "Nada de esa semana está liquidado todavía."
                  : frozen === 1
                    ? "1 labor de esa semana ya está liquidada y no se toca: su precio quedó congelado."
                    : `${frozen} labores de esa semana ya están liquidadas y no se tocan: su precio quedó congelado.`}
              </Typography>
            </Stack>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="h3" gutterBottom>
            Las últimas semanas
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Semana</TableCell>
                <TableCell align="right">Precio por kilo</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {history === null && (
                <TableRow>
                  <TableCell colSpan={2} sx={{ color: "text.secondary" }}>
                    Consultando el precio de cada semana…
                  </TableCell>
                </TableRow>
              )}
              {history?.map((h) => (
                <TableRow
                  key={h.monday}
                  hover
                  selected={h.monday === monday}
                  onClick={() => {
                    setMonday(h.monday);
                    setDraft("");
                    setSaved(null);
                  }}
                  sx={{ cursor: "pointer" }}
                >
                  <TableCell>
                    {formatWeekRange(h.monday)}
                    {weekTag(h.monday, today) && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={weekTag(h.monday, today)}
                        sx={{ ml: 1, height: 20, fontSize: "0.68rem" }}
                      />
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {/* A dash, not a zero: "$0 por kilo" is a week in which
                        the farm paid nothing, which does not exist. */}
                    {h.cents === null ? (
                      <Box component="span" sx={{ color: "text.disabled", fontWeight: 600 }}>
                        —
                      </Box>
                    ) : (
                      <Money cents={h.cents} variant="small" />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
            Este precio no es el de una actividad. Una actividad con{" "}
            <strong>precio fijo</strong> —una guadañada por jornal, una siembra por
            contrato— lleva el suyo y se cambia en{" "}
            <Button component={RouterLink} to="/actividades" size="small" sx={{ p: 0, minWidth: 0 }}>
              Actividades
            </Button>
            . El de aquí es el del kilo recogido, semana por semana.
          </Alert>
        </CardContent>
      </Card>

      {/* ── LOOK BEFORE YOU SIGN ─────────────────────────────────────────
          The payroll's pattern again: the confirmation shows the old figure,
          the new one, the difference, and how much picking it re-values. */}
      <Dialog open={confirming} onClose={() => setConfirming(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          Fijar el kilo de la semana del {formatWeekRange(monday)} en{" "}
          {formatMoney(newCents ?? 0)}
        </DialogTitle>
        <DialogContent dividers>
          <DialogContentText component="div">
            Esto cambia lo que vale la recolección de esa semana que todavía{" "}
            <strong>no se ha liquidado</strong>. Lo que ya se liquidó conserva el precio
            que congeló: esa es la razón de liquidar.
          </DialogContentText>

          <Stack
            direction="row"
            spacing={2}
            sx={{ mt: 2.5 }}
            divider={<Divider orientation="vertical" flexItem />}
          >
            <Box>
              <Typography variant="overline" color="text.secondary">
                Estaba en
              </Typography>
              {currentCents === null ? <Typography>—</Typography> : <Money cents={currentCents} />}
            </Box>
            <Box>
              <Typography variant="overline" color="text.secondary">
                Queda en
              </Typography>
              <Money cents={newCents ?? 0} variant="big" />
            </Box>
          </Stack>

          {data?.records !== null && movable.length > 0 && (
            <>
              <Divider sx={{ my: 2 }} />
              <Stack spacing={0.5}>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2" color="text.secondary">
                    {movable.length}{" "}
                    {movable.length === 1 ? "labor sin liquidar" : "labores sin liquidar"}, hoy
                  </Typography>
                  <Money cents={beforeCents} variant="small" />
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2" color="text.secondary">
                    Con el precio nuevo
                  </Typography>
                  <Money cents={afterCents} variant="small" />
                </Stack>
                <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                  <Typography variant="h3">Diferencia</Typography>
                  <Money cents={afterCents - beforeCents} signed colored />
                </Stack>
              </Stack>
            </>
          )}

          {data?.records !== null && movable.length === 0 && (
            <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
              No hay recolección sin liquidar en esa semana, así que hoy no cambia ninguna
              cifra. El precio queda puesto para lo que se registre después.
            </Alert>
          )}

          {monday !== thisMonday && (
            <Alert severity="warning" variant="outlined" sx={{ mt: 2 }}>
              Es una semana pasada. Fijar su precio ahora mueve lo que quedó sin liquidar
              de esa semana, no lo de esta.
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setConfirming(false)}>
            Ahora no
          </Button>
          <Button variant="contained" disabled={busy} onClick={save}>
            {busy ? "Guardando…" : `Fijar en ${formatMoney(newCents ?? 0)}`}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
