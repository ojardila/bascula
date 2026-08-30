/**
 * THE ONLY WAY A QUANTITY IN THIS APP EVER CHANGES.
 *
 * There is no "editar la cantidad en stock" anywhere, and this dialog is why
 * there does not need to be one. `docs/modelo-datos.md`: "existencias
 * derivadas de entradas y salidas, igual que el saldo se deriva del ledger. Un stock
 * materializado es un total que se desincroniza de sus hechos, y ya sabemos
 * qué opinamos de eso."
 *
 * The screen has to make that feel like a feature rather than an obstruction,
 * because to somebody who has used a spreadsheet, "type 18 into the stock
 * column" is the obvious thing and being unable to do it is baffling. Three
 * decisions do that work:
 *
 *  - THE PREVIEW. "Hay 30 Bulto. Después de esto quedan 18." The
 *    person still gets to see the number they were going to type; they just
 *    reach it by saying what happened.
 *  - THE REASON IS THE FIRST FIELD, not a footnote. Choosing "merma" and
 *    typing 12 is a sentence; typing 18 into a box is not, and in March
 *    nobody can say why the coffee went.
 *  - THE SIGN IS NOT THE PERSON'S PROBLEM. The quantity box takes a positive
 *    number and `signedQty` applies the direction from the reason, which is
 *    what `stock_sign` in the database says too. The two reasons the database
 *    leaves free — traslado and ajuste — are the only ones that ask.
 *
 * And "ajuste" is where a spreadsheet habit lands softly: it exists, it is
 * signed either way, and it is recorded as an adjustment with a note, which is
 * a fact about a correction rather than a silent overwrite of a total.
 */
import { useMemo, useState } from "react";
import {
  Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent,
  DialogTitle, FormControlLabel, MenuItem, Stack, Switch, TextField,
  ToggleButton, ToggleButtonGroup, Typography,
} from "@mui/material";
import { CatalogPicker, type CatalogValue } from "../../components/CatalogPicker";
import { DateField } from "../../components/DateField";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { useWriteOnce } from "../../lib/writeOnce";
import { formatQuantity, parseQuantityInput } from "../../lib/money";
import { unitLabel } from "../../lib/plural";
import { reasonNeedsDirection, signedQty, stockAfter } from "../../lib/stock";
import { todayInFarm } from "../../lib/dates";
import { STOCK_MOVE } from "../../lib/vocab";
import { useAuth } from "../../auth/AuthContext";
import {
  STOCK_REASON_LABEL, type CatalogItem, type LabelBatch, type Plot, type Product,
  type StockMove, type StockReason,
} from "../../api/types";

/** Every reason except `venta`, which belongs to a sale and not to this form. */
const REASONS: StockReason[] = ["cosecha", "compra", "consumo", "merma", "traslado", "ajuste"];

const REASON_HELP: Record<StockReason, string> = {
  cosecha: "Entró producto recogido en la finca.",
  compra: "Entró producto comprado a un tercero.",
  venta: "Las ventas se registran en el módulo de Ventas, que además guarda a quién y por cuánto.",
  consumo: "Salió producto usado en la finca (abono aplicado, semilla sembrada…).",
  merma: "Se perdió producto: se dañó, se derramó, se lo comió una plaga.",
  traslado: "El producto cambió de bodega. Registre la salida de una y la entrada en la otra.",
  ajuste: "El conteo físico no cuadra con el sistema. Diga cuánto sobra o falta y por qué.",
};

export interface StockMoveDialogProps {
  open: boolean;
  products: Product[];
  warehouses: CatalogItem[];
  plots: Plot[];
  /** Preselected when the dialog was opened from a product's row. */
  product?: Product | null;
  /** Current quantity of that product in the chosen warehouse, for the preview. */
  stockOf: (productId: string, warehouseId: string | null) => number | null;
  onClose: () => void;
  onSaved: (move: StockMove, labelBatch: LabelBatch | null) => void;
}

export function StockMoveDialog({
  open, products, warehouses, plots, product, stockOf, onClose, onSaved,
}: StockMoveDialogProps) {
  const { user } = useAuth();
  const today = todayInFarm(user?.farm.timezone ?? "America/Bogota");

  const [productId, setProductId] = useState(product?.id ?? "");
  /**
   * NO DEFAULT WAREHOUSE unless the farm has exactly one.
   *
   * The first version of this defaulted to `warehouses[0]`, which is the
   * alphabetically first — so a farm with a "Beneficiadero" and a "Bodega
   * principal" got the beneficiadero preselected on every movement, and the
   * quickest path through the form put the coffee in the wrong shed. A field
   * whose default is arbitrary is worse than an empty one, because an empty
   * one is visibly unanswered.
   */
  const [warehouse, setWarehouse] = useState<CatalogValue | null>(
    warehouses.length === 1 ? { id: warehouses[0].id, name: warehouses[0].name } : null,
  );
  const [reason, setReason] = useState<StockReason>("cosecha");
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [qty, setQty] = useState("");
  const [plotId, setPlotId] = useState("");
  const [plotCropId, setPlotCropId] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(today);
  const [labels, setLabels] = useState(false);
  const [anyway, setAnyway] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const { busy, run: runOnce } = useWriteOnce();

  const chosen = products.find((p) => p.id === productId) ?? null;
  const chosenPlot = plots.find((p) => p.id === plotId) ?? null;
  const magnitude = parseQuantityInput(qty);
  const signed = magnitude === null ? null : signedQty(magnitude, reason, direction);
  const available = useMemo(
    () => (productId && warehouse?.id ? stockOf(productId, warehouse.id) : null),
    [productId, warehouse, stockOf],
  );
  const goesNegative =
    available !== null && signed !== null && signed < 0 && stockAfter(available, signed) < 0;

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!productId) e.product = "Elija el producto.";
    if (!warehouse) e.warehouse = "Elija la bodega.";
    if (!qty.trim()) e.qty = "Escriba la cantidad.";
    else if (magnitude === null) e.qty = "Escriba un número, por ejemplo 12,5.";
    else if (magnitude <= 0) {
      e.qty = "Escriba la cantidad en positivo. El signo lo pone el motivo.";
    }
    // `stock_crop_needs_plot`: a crop always belongs to the lot it is planted
    // in, so a crop with no lot is a row the database will not take.
    if (plotCropId && !plotId) e.plot = "Elija primero el lote de ese cultivo.";
    if (reason === "ajuste" && !note.trim()) {
      e.note = "Un ajuste sin explicación es un número que nadie podrá justificar después.";
    }
    // The server guards EVERY outgoing movement, not just a sale: a consumo
    // for more than there is comes back 409 INSUFFICIENT_STOCK. Asking here
    // means the person fixes the number, or records the missing entry, or says
    // they know — rather than filling the form in and being refused at the end.
    if (goesNegative && !anyway) {
      e.qty = "En esa bodega no hay tanto. Corrija la cantidad, registre la entrada que falta, o marque la casilla de abajo.";
    }
    setFields(e);
    return Object.keys(e).length === 0;
  }

  async function save() {
    if (!validate() || signed === null || !warehouse) return;
    // One movement per filled-in form: a double click used to move the stock
    // twice, and with the id minted inside the call the second request was a
    // new movement rather than a retry. See `lib/writeOnce.ts`.
    const intent = ["entrada-salida", productId, warehouse.id ?? warehouse.name, signed,
                    reason, date, plotId, plotCropId].join("|");
    const outcome = await runOnce(intent, async (mint) => {
      setError(null);
      // The warehouse is created FIRST, as its own call, because
      // `StockMoveInput.warehouseId` is required — there is no "create it on
      // the way past" on this route the way there is for a category. That is
      // right: a typo must not be able to invent a shed in the middle of a
      // movement, and `POST /v1/warehouses` is idempotent by lower(name) so
      // choosing an existing one by typing its name is safe.
      const warehouseId = warehouse.id ?? (await api.createWarehouse(warehouse.name)).id;
      return api.createStockMove({
        id: mint(),
        productId,
        warehouseId,
        plotId: plotId || null,
        plotCropId: plotCropId || null,
        qty: signed,
        reason,
        note: note.trim() || null,
        date,
        ...(anyway ? { allowNegative: true } : {}),
        // RSP-025: the stickers are asked for WITH the movement, in one call.
        // One per unit, capped — a hundred labels for a hundred kilos of
        // cherry is a jammed printer, not a helpful default.
        ...(labels && signed > 0
          ? { labels: Math.max(1, Math.min(24, Math.round(signed))) }
          : {}),
      });
    }).catch((e: unknown) => {
      setError(messageFor(e));
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    onSaved(outcome.value.move, outcome.value.labelBatch);
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Registrar una entrada o una salida</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Las existencias no se escriben: salen de sumar lo que entra y lo que sale. Diga qué pasó y
          el sistema calcula cuánto queda.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            select
            label="Motivo"
            value={reason}
            onChange={(e) => setReason(e.target.value as StockReason)}
            helperText={REASON_HELP[reason]}
            fullWidth
            required
          >
            {REASONS.map((r) => (
              <MenuItem key={r} value={r}>
                {STOCK_REASON_LABEL[r]}
              </MenuItem>
            ))}
          </TextField>

          {reasonNeedsDirection(reason) && (
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
                ¿Entra o sale?
              </Typography>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={direction}
                onChange={(_, v) => v && setDirection(v as "in" | "out")}
                aria-label="¿Entra o sale?"
              >
                <ToggleButton value="in">Entra</ToggleButton>
                <ToggleButton value="out">Sale</ToggleButton>
              </ToggleButtonGroup>
            </Box>
          )}

          <TextField
            select
            label="Producto"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            error={!!fields.product}
            helperText={fields.product}
            fullWidth
            required
          >
            {products.map((p) => (
              <MenuItem key={p.id} value={p.id}>
                {p.name} ({p.storageUnit})
              </MenuItem>
            ))}
          </TextField>

          <CatalogPicker
            label="Bodega"
            addWhat="la bodega"
            options={warehouses}
            value={warehouse}
            onChange={setWarehouse}
            error={fields.warehouse}
            required
          />

          <TextField
            label={`Cantidad${chosen ? ` (${chosen.storageUnit})` : ""}`}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            error={!!fields.qty}
            helperText={fields.qty ?? "En positivo. El motivo decide si entra o sale."}
            inputMode="decimal"
            fullWidth
            required
          />

          {/* The number they were going to type, arrived at the other way. */}
          {chosen && available !== null && signed !== null && (
            <Alert severity="info" icon={false}>
              Hoy hay{" "}
              <strong>
                {formatQuantity(available)} {unitLabel(available, chosen.storageUnit)}
              </strong>{" "}
              en{" "}
              {warehouse?.name}. Después de esto quedan{" "}
              <strong>
                {formatQuantity(stockAfter(available, signed))}{" "}
                {unitLabel(stockAfter(available, signed), chosen.storageUnit)}
              </strong>
              .
            </Alert>
          )}

          {goesNegative && (
            <Alert severity="warning">
              Queda en negativo: puede que falte registrar una entrada anterior.
              <FormControlLabel
                sx={{ display: "block", mt: 1 }}
                control={
                  <Checkbox checked={anyway} onChange={(e) => setAnyway(e.target.checked)} />
                }
                label="Regístrelo de todos modos: pasó, y la bodega está desactualizada."
              />
            </Alert>
          )}

          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              select
              label="Lote (opcional)"
              value={plotId}
              onChange={(e) => {
                setPlotId(e.target.value);
                setPlotCropId("");
              }}
              error={!!fields.plot}
              helperText={fields.plot ?? "De dónde salió, o a dónde fue"}
              fullWidth
            >
              <MenuItem value="">—</MenuItem>
              {plots.map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {p.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Cultivo (opcional)"
              value={plotCropId}
              onChange={(e) => setPlotCropId(e.target.value)}
              disabled={!chosenPlot}
              fullWidth
            >
              <MenuItem value="">—</MenuItem>
              {(chosenPlot?.crops ?? []).map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.cropTypeName}
                  {c.varietyName ? ` · ${c.varietyName}` : ""}
                </MenuItem>
              ))}
            </TextField>
          </Stack>

          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <DateField label="Fecha" value={date} onChange={setDate} />
            <TextField
              label={reason === "ajuste" ? "Por qué se ajusta" : "Nota (opcional)"}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              error={!!fields.note}
              helperText={fields.note}
              fullWidth
              required={reason === "ajuste"}
            />
          </Stack>

          {signed !== null && signed > 0 && (
            <FormControlLabel
              control={<Switch checked={labels} onChange={(e) => setLabels(e.target.checked)} />}
              label="Imprimir stickers de identificación"
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button variant="contained" onClick={save} disabled={busy}>
          {busy ? "Guardando…" : `Registrar ${STOCK_MOVE.one}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
