/**
 * «PRECIOS ESPECIALES»: a fixed kilo price for one lote or one person, from a
 * Monday on (migration 00034).
 *
 * Which price pays a kilo, first match wins, said on screen in plain words:
 *   persona > lote > semana > finca.
 * A settled week never changes: before saving, the card says how many
 * weighings take the new price and how many are already settled and keep
 * theirs. Ending a special price is "desde este lunes, sin precio especial",
 * never a rewrite of the weeks it already paid.
 *
 * This card is also tour step 2 (data-tour="price-exceptions"): the tour only
 * points at it; "Puede hacerlo después".
 */
import { useEffect, useMemo, useState } from "react";
import {
  Alert, Box, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle,
  InputAdornment, MenuItem, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography,
  useMediaQuery, useTheme,
} from "@mui/material";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { addDays, parseDay } from "../../lib/dates";
import { formatMoney, parseMoneyInput } from "../../lib/money";
import type { WireSpecialPrice, WireSpecialPriceImpact, WireSpecialPriceKind } from "../../api/wire";
import { formatMondayLong } from "./BasePriceCard";

function groupPesos(digits: string): string {
  const clean = digits.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return clean.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const KIND_WORD: Record<WireSpecialPriceKind, string> = { lote: "Lote", persona: "Persona" };

interface Editing {
  kind: WireSpecialPriceKind;
  targetId: string | null;
  /** Set when the dialog ends a special price instead of setting one. */
  ending: boolean;
}

export function SpecialPricesCard({ canEdit }: { canEdit: boolean }) {
  const [tick, setTick] = useState(0);
  const { data, error } = useAsync(() => api.listSpecialPrices(), [tick]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const items = data ?? [];

  return (
    <Card data-tour="price-exceptions" variant="outlined" sx={{ mb: 3, borderRadius: 4 }}>
      <CardContent sx={{ p: { xs: 2.25, sm: 3 } }}>
        <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" sx={{ mb: 1 }}>
          <Typography variant="h3" component="h2" sx={{ fontSize: 21, fontWeight: 800 }}>
            Precios especiales
          </Typography>
          {items.length === 0 && <Chip label="Puede hacerlo después" variant="outlined" sx={{ fontSize: 14 }} />}
        </Stack>
        <Typography sx={{ fontSize: 17 }}>
          Si un lote o una persona se paga distinto, póngale un precio fijo por kilo desde un lunes.
        </Typography>
        <Box sx={{ mt: 1.5, p: 1.5, borderRadius: 2, bgcolor: "#f6f8f5" }}>
          <Typography sx={{ fontSize: 16, fontWeight: 700, mb: 0.5 }}>¿Qué precio se paga?</Typography>
          <Typography sx={{ fontSize: 16 }}>
            Primero el de la <strong>persona</strong>, si tiene. Si no, el del <strong>lote</strong>. Si no, el de
            la <strong>semana</strong>. Si no, el de la <strong>finca</strong>.
          </Typography>
        </Box>

        {error && <Alert severity="error" sx={{ mt: 2 }}>No se pudieron leer los precios especiales: {error}</Alert>}
        {savedMsg && (
          <Alert severity="success" sx={{ mt: 2, fontSize: 16 }} onClose={() => setSavedMsg(null)}>
            {savedMsg}
          </Alert>
        )}

        {items.length > 0 && (
          <Stack spacing={1.25} sx={{ mt: 2 }}>
            {items.map((it) => (
              <SpecialRow
                key={`${it.kind}-${it.targetId}`}
                item={it}
                canEdit={canEdit}
                onChange={() => setEditing({ kind: it.kind, targetId: it.targetId, ending: false })}
                onEnd={() => setEditing({ kind: it.kind, targetId: it.targetId, ending: true })}
              />
            ))}
          </Stack>
        )}

        {canEdit && (
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 2.5 }}>
            <Button
              variant="outlined"
              onClick={() => setEditing({ kind: "lote", targetId: null, ending: false })}
              sx={{ borderRadius: 999, minHeight: 52, px: 3, fontSize: 17, fontWeight: 700 }}
            >
              Precio especial para un lote
            </Button>
            <Button
              variant="outlined"
              onClick={() => setEditing({ kind: "persona", targetId: null, ending: false })}
              sx={{ borderRadius: 999, minHeight: 52, px: 3, fontSize: 17, fontWeight: 700 }}
            >
              Precio especial para una persona
            </Button>
          </Stack>
        )}
        <Typography sx={{ fontSize: 15, color: "text.secondary", mt: 1.5 }}>
          Para una sola semana, use «Precio de una semana», más abajo.
        </Typography>
      </CardContent>

      {editing && (
        <SpecialPriceDialog
          editing={editing}
          existing={items}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setSavedMsg(msg);
            setTick((t) => t + 1);
          }}
        />
      )}
    </Card>
  );
}

function SpecialRow({
  item, canEdit, onChange, onEnd,
}: { item: WireSpecialPrice; canEdit: boolean; onChange: () => void; onEnd: () => void }) {
  const [open, setOpen] = useState(false);
  const latest = item.history[0];
  return (
    <Box sx={{ p: 1.5, borderRadius: 3, border: 1, borderColor: "divider" }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <Chip size="small" label={KIND_WORD[item.kind]} sx={{ fontWeight: 700 }} />
            <Typography sx={{ fontSize: 18, fontWeight: 800 }}>{item.targetName}</Typography>
          </Stack>
          <Typography sx={{ fontSize: 17, mt: 0.5 }}>
            {item.currentCents !== null ? (
              <><strong>{formatMoney(item.currentCents)} por kilo</strong> esta semana</>
            ) : (
              <>Sin precio especial esta semana</>
            )}
          </Typography>
          {latest && latest.validFrom > todayMonday() && (
            <Typography sx={{ fontSize: 15, color: "text.secondary" }}>
              {latest.priceCents !== null
                ? `Desde el ${formatMondayLong(latest.validFrom)}: ${formatMoney(latest.priceCents)}`
                : `Desde el ${formatMondayLong(latest.validFrom)}: sin precio especial`}
            </Typography>
          )}
        </Box>
        {canEdit && (
          <Stack direction="row" spacing={1}>
            <Button onClick={onChange} sx={{ fontSize: 16, fontWeight: 700, minHeight: 44 }}>Cambiar</Button>
            {item.currentCents !== null && (
              <Button color="inherit" onClick={onEnd} sx={{ fontSize: 16, minHeight: 44 }}>Quitar</Button>
            )}
          </Stack>
        )}
      </Stack>
      {item.history.length > 0 && (
        <Button size="small" onClick={() => setOpen((o) => !o)} sx={{ mt: 0.5, fontSize: 15, px: 0 }}>
          {open ? "Ocultar historial" : `Ver historial (${item.history.length})`}
        </Button>
      )}
      {open && (
        <Stack spacing={0.5} sx={{ mt: 0.5 }}>
          {item.history.map((h) => (
            <Typography key={h.validFrom} sx={{ fontSize: 15 }}>
              Desde el {formatMondayLong(h.validFrom)}:{" "}
              <strong>{h.priceCents !== null ? `${formatMoney(h.priceCents)} por kilo` : "sin precio especial"}</strong>
            </Typography>
          ))}
        </Stack>
      )}
    </Box>
  );
}

function todayMonday(): string {
  const d = new Date();
  const local = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = (local.getUTCDay() + 6) % 7;
  return addDays(local, -dow).toISOString().slice(0, 10);
}

function SpecialPriceDialog({
  editing, existing, onClose, onSaved,
}: {
  editing: Editing;
  existing: WireSpecialPrice[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"));
  const [kind, setKind] = useState<WireSpecialPriceKind>(editing.kind);
  const [targetId, setTargetId] = useState<string>(editing.targetId ?? "");
  const [text, setText] = useState("");
  const [monday, setMonday] = useState(todayMonday());
  const [impact, setImpact] = useState<WireSpecialPriceImpact | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ending = editing.ending;

  const { data: plots } = useAsync(() => (kind === "lote" ? api.listPlots() : Promise.resolve([])), [kind]);
  const { data: workers } = useAsync(() => (kind === "persona" ? api.listWorkers() : Promise.resolve([])), [kind]);
  const options = useMemo(
    () =>
      kind === "lote"
        ? (plots ?? []).map((p) => ({ id: p.id, name: p.name }))
        : (workers ?? []).map((w) => ({ id: w.id, name: `${w.name} ${w.lastName ?? ""}`.trim() })),
    [kind, plots, workers],
  );
  const targetName =
    options.find((o) => o.id === targetId)?.name ??
    existing.find((e) => e.targetId === targetId)?.targetName ??
    "";

  const mondays = useMemo(() => {
    const base = parseDay(todayMonday());
    const out: string[] = [];
    for (let i = 4; i >= -8; i--) out.push(addDays(base, 7 * i).toISOString().slice(0, 10));
    return out;
  }, []);

  useEffect(() => {
    if (!targetId) {
      setImpact(null);
      return;
    }
    let cancelled = false;
    api
      .specialPriceImpact(kind, targetId, monday)
      .then((im) => !cancelled && setImpact(im))
      .catch(() => !cancelled && setImpact(null));
    return () => {
      cancelled = true;
    };
  }, [kind, targetId, monday]);

  const cents = parseMoneyInput(text);
  const impactText = impact
    ? impact.unsettledRecords === 0 && impact.settledRecords === 0 && impact.overriddenByPerson === 0
      ? "Todavía no hay pesadas desde ese lunes: cuenta con las próximas."
      : `Desde ese lunes, ${impact.unsettledRecords} ${impact.unsettledRecords === 1 ? "pesada sin liquidar cambia" : "pesadas sin liquidar cambian"}. ` +
        (impact.settledRecords > 0
          ? `${impact.settledRecords} ${impact.settledRecords === 1 ? "pesada ya liquidada no cambia" : "pesadas ya liquidadas no cambian"}. `
          : "Lo ya liquidado no cambia. ") +
        (impact.overriddenByPerson > 0
          ? `${impact.overriddenByPerson} ${impact.overriddenByPerson === 1 ? "pesada es" : "pesadas son"} de personas con precio propio, que manda.`
          : "")
    : null;

  async function save() {
    setSaveError(null);
    if (!targetId) {
      setFieldError(kind === "lote" ? "Escoja el lote." : "Escoja la persona.");
      return;
    }
    if (!ending) {
      if (cents === null) {
        setFieldError("Escriba el precio en pesos. Por ejemplo: 1.000");
        return;
      }
      if (cents < 10000) {
        setFieldError(`¿Seguro? ${formatMoney(cents)} por kilo es muy poco. Escriba el precio en pesos, por ejemplo 1.000.`);
        return;
      }
    }
    setFieldError(null);
    setBusy(true);
    try {
      await api.setSpecialPrice(kind, targetId, monday, ending ? null : cents);
      onSaved(
        ending
          ? `Listo: ${targetName} queda sin precio especial desde el ${formatMondayLong(monday)}. Lo ya liquidado no cambia.`
          : `Listo: ${targetName} se paga a ${formatMoney(cents!)} por kilo desde el ${formatMondayLong(monday)}. Lo ya liquidado no cambia.`,
      );
    } catch (e) {
      setSaveError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  const title = ending
    ? `Quitar el precio especial de ${targetName}`
    : editing.targetId
      ? `Cambiar el precio de ${targetName}`
      : "Nuevo precio especial";

  return (
    <Dialog open onClose={onClose} fullScreen={phone} fullWidth maxWidth="sm">
      <DialogTitle sx={{ fontSize: 22, fontWeight: 800 }}>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          {!editing.targetId && (
            <ToggleButtonGroup
              exclusive
              fullWidth
              value={kind}
              onChange={(_, v: WireSpecialPriceKind | null) => {
                if (v) {
                  setKind(v);
                  setTargetId("");
                }
              }}
            >
              <ToggleButton value="lote" sx={{ fontSize: 17, minHeight: 52 }}>Un lote</ToggleButton>
              <ToggleButton value="persona" sx={{ fontSize: 17, minHeight: 52 }}>Una persona</ToggleButton>
            </ToggleButtonGroup>
          )}
          {!editing.targetId && (
            <TextField
              select
              label={kind === "lote" ? "¿Qué lote?" : "¿Qué persona?"}
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              slotProps={{ select: { sx: { fontSize: 19, py: 1.75 } } }}
              fullWidth
            >
              {options.map((o) => (
                <MenuItem key={o.id} value={o.id} sx={{ fontSize: 18, minHeight: 48 }}>{o.name}</MenuItem>
              ))}
            </TextField>
          )}
          {!ending && (
            <TextField
              label="Precio por kilo"
              value={text}
              onChange={(e) => {
                setText(groupPesos(e.target.value));
                setFieldError(null);
              }}
              helperText="En pesos, sin centavos. Ejemplo: 1.000"
              slotProps={{
                htmlInput: { inputMode: "numeric", "aria-label": "Precio especial por kilo en pesos", style: { fontSize: 32, fontWeight: 800, paddingTop: 12, paddingBottom: 12 } },
                input: {
                  startAdornment: <InputAdornment position="start"><Typography sx={{ fontSize: 26 }}>$</Typography></InputAdornment>,
                  endAdornment: <InputAdornment position="end"><Typography sx={{ fontSize: 17 }}>por kilo</Typography></InputAdornment>,
                },
                formHelperText: { sx: { fontSize: 15 } },
              }}
              fullWidth
            />
          )}
          <TextField
            select
            label="Desde"
            value={monday}
            onChange={(e) => setMonday(e.target.value)}
            helperText={ending ? "Desde este lunes se vuelve a pagar el precio normal." : "Las pesadas desde este lunes se pagan a este precio."}
            slotProps={{ select: { sx: { fontSize: 19, py: 1.75 } }, formHelperText: { sx: { fontSize: 15 } } }}
            fullWidth
          >
            {mondays.map((m) => (
              <MenuItem key={m} value={m} sx={{ fontSize: 18, minHeight: 48 }}>
                {formatMondayLong(m)}{m === todayMonday() ? " (esta semana)" : ""}
              </MenuItem>
            ))}
          </TextField>
          {fieldError && <Alert severity="warning" sx={{ fontSize: 16 }}>{fieldError}</Alert>}
          {impactText && <Alert severity="info" variant="outlined" sx={{ fontSize: 16 }}>{impactText}</Alert>}
          {saveError && <Alert severity="error">{saveError}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ p: 2, gap: 1, flexDirection: phone ? "column-reverse" : "row" }}>
        <Button onClick={onClose} fullWidth={phone} sx={{ fontSize: 17, minHeight: 48 }}>Cancelar</Button>
        <Button
          variant="contained"
          onClick={() => void save()}
          disabled={busy}
          fullWidth={phone}
          sx={{ borderRadius: 999, minHeight: 52, px: 4, fontSize: 18, fontWeight: 700 }}
        >
          {ending ? "Sí, quitar el precio" : "Guardar precio especial"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
