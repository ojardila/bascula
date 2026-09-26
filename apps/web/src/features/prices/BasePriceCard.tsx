/**
 * «PRECIO DE LA FINCA»: the base price of a kilo, from a Monday on.
 *
 * Until migration 00030 the farm had one price with no date, and changing it
 * silently repriced every unsettled week. Now it is "$1.000 por kilo desde el
 * lunes 21 sep", with its history, and the approved rule is spelled out
 * before saving: a new price moves only the work that has NOT been settled;
 * settled weeks never change.
 *
 * This is also step 1 of the owner's guided tour. A farm signed up from the
 * landing has a default price nobody chose ($800); the tour asks the owner to
 * confirm or change it here, instead of paying $800 in silence.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Alert, Box, Button, Card, CardContent, Chip, InputAdornment, MenuItem, Stack, TextField, Typography,
} from "@mui/material";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { addDays, parseDay } from "../../lib/dates";
import { formatMoney, parseMoneyInput } from "../../lib/money";
import type { WireBasePriceImpact, WireBasePriceState } from "../../api/wire";
import { useTour, useTourAction } from "../onboarding/TourContext";

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const SINCE_ALWAYS = "2000-01-03";

/** "lunes 21 sep 2026". */
export function formatMondayLong(iso: string): string {
  const d = parseDay(iso);
  return `lunes ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Pesos as people write them here: 1000 -> "1.000". */
function groupPesos(digits: string): string {
  const clean = digits.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return clean.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function priceOn(state: WireBasePriceState, monday: string): number | null {
  const row = state.history.find((p) => p.validFrom <= monday);
  return row ? row.priceCents : null;
}

export function BasePriceCard({ onSaved }: { onSaved?: () => void }) {
  const tour = useTour();
  const [tick, setTick] = useState(0);
  const { data, error } = useAsync(() => api.getBasePrice(), [tick]);
  const [draft, setDraft] = useState<string | null>(null);
  const [validFrom, setValidFrom] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<WireBasePriceImpact | null>(null);

  const thisWeek = data?.thisWeek ?? null;
  const monday = validFrom ?? thisWeek;
  const text = draft ?? (data ? groupPesos(String(Math.round(data.currentCents / 100))) : "");
  const newCents = parseMoneyInput(text);
  const before = data && monday ? priceOn(data, monday) : null;
  const changed = !!data && newCents !== null && (newCents !== before || !data.confirmed);

  const mondays = useMemo(() => {
    if (!thisWeek) return [];
    const out: string[] = [];
    for (let i = 4; i >= -8; i--) out.push(addDays(parseDay(thisWeek), 7 * i).toISOString().slice(0, 10));
    return out;
  }, [thisWeek]);

  useEffect(() => {
    if (!monday) return;
    let cancelled = false;
    api
      .basePriceImpact(monday)
      .then((im) => !cancelled && setImpact(im))
      .catch(() => !cancelled && setImpact(null));
    return () => {
      cancelled = true;
    };
  }, [monday, tick]);

  function validate(): boolean {
    setSaveError(null);
    if (newCents === null) {
      setFieldError("Escriba el precio en pesos. Por ejemplo: 1.000");
      return false;
    }
    if (newCents < 10000) {
      setFieldError(`¿Seguro? ${formatMoney(newCents)} por kilo es muy poco. Escriba el precio en pesos, por ejemplo 1.000.`);
      return false;
    }
    setFieldError(null);
    return true;
  }

  async function save(): Promise<boolean> {
    if (!monday || newCents === null) return false;
    setBusy(true);
    try {
      const st = await api.setBasePrice(monday, newCents);
      tour.note({ priceCents: st.currentCents });
      setSavedMsg(
        `Listo: ${formatMoney(newCents)} por kilo desde el ${formatMondayLong(monday)}. ` +
          "Lo ya liquidado no cambia.",
      );
      setDraft(null);
      setValidFrom(null);
      setTick((t) => t + 1);
      onSaved?.();
      return true;
    } catch (e) {
      setSaveError(messageFor(e));
      return false;
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  // Tour step 1: «Continuar» keeps a price that is already right, or saves
  // the one on screen.
  useTourAction("save-base-price", async () => {
    if (!data) return false;
    if (!validate()) return false;
    if (!changed) {
      tour.note({ priceCents: newCents });
      return true;
    }
    return save();
  });

  const impactText = impact
    ? impact.unsettledRecords === 0 && impact.settledRecords === 0
      ? "Todavía no hay pesadas desde ese día: el precio empieza a contar con las próximas."
      : `Desde ese lunes, ${impact.unsettledRecords} ${impact.unsettledRecords === 1 ? "pesada sin liquidar toma" : "pesadas sin liquidar toman"} este precio. ` +
        (impact.settledRecords > 0
          ? `${impact.settledRecords} ${impact.settledRecords === 1 ? "pesada ya liquidada no cambia" : "pesadas ya liquidadas no cambian"}.`
          : "Lo ya liquidado no cambia.") +
        (impact.weeksWithOwnPrice > 0
          ? ` ${impact.weeksWithOwnPrice === 1 ? "Una semana tiene" : `${impact.weeksWithOwnPrice} semanas tienen`} su propio precio y lo conserva${impact.weeksWithOwnPrice === 1 ? "" : "n"}.`
          : "")
    : null;

  return (
    <Card data-tour="base-price" sx={{ mb: 3, borderRadius: 4 }}>
      <CardContent sx={{ p: { xs: 2.25, sm: 3 } }}>
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 0.5 }} flexWrap="wrap">
          <Typography variant="h3" component="h2" sx={{ fontSize: 22, fontWeight: 800 }}>
            Precio de la finca
          </Typography>
          {data && !data.confirmed && (
            <Chip color="warning" label="Sin confirmar" sx={{ fontWeight: 700, fontSize: 14 }} />
          )}
        </Stack>
        <Typography sx={{ fontSize: 17, color: "text.secondary", mb: 2.5 }}>
          Lo que la finca paga por cada kilo recogido, desde el lunes que usted diga.
        </Typography>

        {error && <Alert severity="error" sx={{ mb: 2 }}>No se pudo leer el precio de la finca: {error}</Alert>}
        {data && !data.confirmed && (
          <Alert severity="warning" sx={{ mb: 2, fontSize: 16 }}>
            Este precio lo puso la aplicación al crear la finca ({formatMoney(data.currentCents)}). Confírmelo o
            cámbielo por el que usted paga.
          </Alert>
        )}
        {savedMsg && (
          <Alert severity="success" sx={{ mb: 2, fontSize: 16 }} onClose={() => setSavedMsg(null)}>
            {savedMsg}
          </Alert>
        )}
        {saveError && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setSaveError(null)}>
            {saveError}
          </Alert>
        )}

        <Box sx={{ display: "grid", gap: 2.5, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
          <TextField
            label="Precio por kilo"
            value={text}
            onChange={(e) => {
              setDraft(groupPesos(e.target.value));
              setFieldError(null);
            }}
            disabled={!data}
            error={!!fieldError}
            helperText={fieldError ?? "En pesos, sin centavos. Ejemplo: 1.000"}
            slotProps={{
              htmlInput: { inputMode: "numeric", "aria-label": "Precio por kilo en pesos", style: { fontSize: 36, fontWeight: 800, paddingTop: 14, paddingBottom: 14 } },
              input: {
                startAdornment: <InputAdornment position="start"><Typography sx={{ fontSize: 28 }}>$</Typography></InputAdornment>,
                endAdornment: <InputAdornment position="end"><Typography sx={{ fontSize: 18 }}>por kilo</Typography></InputAdornment>,
              },
              formHelperText: { sx: { fontSize: 15 } },
            }}
            fullWidth
          />
          <TextField
            select
            label="Desde"
            value={monday ?? ""}
            onChange={(e) => setValidFrom(e.target.value)}
            disabled={!data}
            helperText="Las pesadas desde este lunes se pagan a este precio."
            slotProps={{
              htmlInput: { style: { fontSize: 20 } },
              select: { sx: { fontSize: 20, py: 2 } },
              formHelperText: { sx: { fontSize: 15 } },
            }}
            fullWidth
          >
            {mondays.map((m) => (
              <MenuItem key={m} value={m} sx={{ fontSize: 18, minHeight: 48 }}>
                {formatMondayLong(m)}
                {m === thisWeek ? " (esta semana)" : ""}
              </MenuItem>
            ))}
          </TextField>
        </Box>

        {newCents !== null && newCents > 0 && (
          <Typography sx={{ fontSize: 16, color: "text.secondary", mt: 2 }}>
            Así se calcula: 20 kg × {formatMoney(newCents)} = <strong>{formatMoney(20 * newCents)}</strong>
          </Typography>
        )}
        {changed && impactText && (
          <Alert severity="info" variant="outlined" sx={{ mt: 2, fontSize: 16 }}>
            {impactText}
          </Alert>
        )}

        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 2.5 }}>
          <Button
            variant="contained"
            disabled={!data || busy}
            onClick={() => {
              if (!validate()) return;
              if (!changed) {
                setSavedMsg(`Ese ya es el precio desde el ${monday ? formatMondayLong(monday) : "lunes"}.`);
                return;
              }
              setConfirming(true);
            }}
            sx={{ borderRadius: 999, minHeight: 52, px: 4, fontSize: 18, fontWeight: 700 }}
          >
            {data && !data.confirmed && !changed ? "Confirmar precio" : "Guardar precio"}
          </Button>
        </Stack>

        {data && data.history.length > 0 && (
          <Box sx={{ mt: 3 }}>
            <Typography sx={{ fontSize: 17, fontWeight: 700, mb: 1 }}>Historial del precio</Typography>
            <Stack spacing={1}>
              {data.history.map((p) => {
                const inForce = thisWeek !== null && priceOn(data, thisWeek) === p.priceCents &&
                  data.history.find((h) => h.validFrom <= thisWeek)?.validFrom === p.validFrom;
                const future = thisWeek !== null && p.validFrom > thisWeek;
                return (
                  <Stack
                    key={p.validFrom}
                    direction="row"
                    alignItems="center"
                    spacing={1.5}
                    sx={{ p: 1.25, borderRadius: 2, bgcolor: inForce ? "#eef6ec" : "transparent", border: 1, borderColor: "divider" }}
                  >
                    <Typography sx={{ fontSize: 17, fontWeight: 700, minWidth: 90 }}>{formatMoney(p.priceCents)}</Typography>
                    <Typography sx={{ fontSize: 16, flex: 1 }}>
                      {p.validFrom === SINCE_ALWAYS ? "Desde el principio" : `${future ? "Empieza el" : "Desde el"} ${formatMondayLong(p.validFrom)}`}
                    </Typography>
                    {inForce && <Chip size="small" color="primary" label="Se paga hoy" />}
                  </Stack>
                );
              })}
            </Stack>
          </Box>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirming}
        title={`¿Pagar ${newCents !== null ? formatMoney(newCents) : ""} por kilo?`}
        body={
          `Desde el ${monday ? formatMondayLong(monday) : "lunes elegido"}. ` +
          (impactText ?? "") +
          " Las semanas ya liquidadas no cambian nunca."
        }
        confirmLabel="Sí, guardar el precio"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void save()}
      />
    </Card>
  );
}

/**
 * Tour step 2: special prices, told and not asked. Per-lote and per-person
 * prices arrive in the next phase; a week's own price already exists below.
 */
export function PriceExceptionsCard() {
  return (
    <Card data-tour="price-exceptions" variant="outlined" sx={{ mb: 3, borderRadius: 4 }}>
      <CardContent sx={{ p: { xs: 2.25, sm: 3 } }}>
        <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" sx={{ mb: 1 }}>
          <Typography variant="h3" component="h2" sx={{ fontSize: 21, fontWeight: 800 }}>
            Precios especiales
          </Typography>
          <Chip label="Puede hacerlo después" variant="outlined" sx={{ fontSize: 14 }} />
        </Stack>
        <Typography sx={{ fontSize: 17 }}>
          Si un lote, una persona o una semana de cosecha alta se paga distinto, se le pone un
          precio fijo que reemplaza al de la finca.
        </Typography>
        <Stack spacing={0.75} sx={{ mt: 1.5 }}>
          <Typography sx={{ fontSize: 16 }}>• <strong>Una semana:</strong> más abajo, en «Precio de una semana».</Typography>
          <Typography sx={{ fontSize: 16 }}>• <strong>Un lote o una persona:</strong> muy pronto, aquí mismo.</Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}
