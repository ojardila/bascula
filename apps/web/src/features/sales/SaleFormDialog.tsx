/**
 * RSP-027: product, quantity, amount, customer, photo of the receipt.
 *
 * TWO THINGS THIS FORM KNOWS THAT THE USE CASE DOES NOT SAY.
 *
 * 1. A SALE TAKES PRODUCT OUT OF A WAREHOUSE. The document lists a product and
 *    a quantity and stops; the schema pairs every sale with a `venta` movement
 *    written in the same transaction, because otherwise the sales list and the
 *    warehouse drift apart with no third record to say which is right. So the
 *    form asks which warehouse, shows what is in it, and warns BEFORE the
 *    server has to refuse — with an override, because the warehouse is not
 *    always in the database before the truck leaves. That override is the same
 *    shape as `allowOverpayment` on a payment and exists for the same reason.
 *
 * 2. THE QUANTITY CANNOT BE EDITED AFTERWARDS, so it is worth getting right
 *    here. Half of it is already a movement in an append-only table by the
 *    time anybody notices the typo; the way back is to void the sale, which
 *    writes the reversal, and record it again.
 *
 * The receipt photo of RSP-027 is NOT here. `attachments` and the upload route
 * are being built on the other side of the wire as this is written and there
 * is nothing to POST a file to yet, so the field is absent rather than present
 * and quietly dropped. An input that swallows a photograph is worse than no
 * input: the person believes the comprobante is stored.
 */
import { useMemo, useState } from "react";
import {
  Alert, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControlLabel, MenuItem, Stack, TextField, Typography,
} from "@mui/material";
import { CatalogPicker, type CatalogValue } from "../../components/CatalogPicker";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { useWriteOnce } from "../../lib/writeOnce";
import { formatMoney, formatQuantity, parseMoneyInput, parseQuantityInput } from "../../lib/money";
import { todayInFarm } from "../../lib/dates";
import { exceedsStock } from "../../lib/stock";
import { useAuth } from "../../auth/AuthContext";
import type { CatalogItem, Customer, Product, Sale, StockLevel } from "../../api/types";
import { DateField } from "../../components/DateField";

export interface SaleFormDialogProps {
  open: boolean;
  products: Product[];
  customers: Customer[];
  warehouses: CatalogItem[];
  /**
   * NULL until `/v1/stock/levels` has answered, and null if it failed.
   *
   * It used to be `StockLevel[]` and the caller passed `levels ?? []`, which
   * made an unanswered request indistinguishable from an empty warehouse. With
   * that route down, EVERY sale came up "no hay tanto en esa bodega" and the
   * only way past the form was to tick "registrar de todos modos" — which
   * sends `allowNegativeStock: true` and switches off the server's own guard.
   * A failed GET must not talk somebody into disabling a check.
   *
   * `InventoryPage.stockOf` already had this right; this dialog was the one
   * place the null was being flattened.
   */
  levels: StockLevel[] | null;
  onClose: () => void;
  onSaved: (s: Sale) => void;
}

export function SaleFormDialog({
  open, products, customers, warehouses, levels, onClose, onSaved,
}: SaleFormDialogProps) {
  const { user } = useAuth();
  const today = todayInFarm(user?.farm.timezone ?? "America/Bogota");

  const [productId, setProductId] = useState("");
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
  const [customer, setCustomer] = useState<CatalogValue | null>(null);
  const [qty, setQty] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [anyway, setAnyway] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const { busy, run: runOnce } = useWriteOnce();

  const product = products.find((p) => p.id === productId) ?? null;
  const quantity = parseQuantityInput(qty);
  const amountCents = parseMoneyInput(amount);

  const available = useMemo(() => {
    // `levels === null` is "we do not know", and it stays unknown. A missing
    // LINE with the levels loaded is a genuine zero — existencias are derived
    // from movements, so no movements really is nothing in the shed.
    if (!levels || !productId || !warehouse?.id) return null;
    const line = levels.find(
      (l) => l.productId === productId && l.warehouseId === warehouse.id,
    );
    return line ? line.qty : 0;
  }, [productId, warehouse, levels]);

  const short =
    available !== null && quantity !== null && quantity > 0 && exceedsStock(available, quantity);

  /** What a unit works out at, so a misplaced zero is visible before saving. */
  const unitPrice =
    quantity && quantity > 0 && amountCents !== null ? Math.round(amountCents / quantity) : null;

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!productId) e.product = "Elija el producto que se vendió.";
    if (!warehouse) e.warehouse = "Elija de qué bodega salió.";
    if (!qty.trim()) e.qty = "Escriba la cantidad.";
    else if (quantity === null) e.qty = "Escriba un número, por ejemplo 12,5.";
    else if (quantity <= 0) e.qty = "Tiene que ser mayor que cero.";
    if (!amount.trim()) e.amount = "Escriba el valor de la venta.";
    else if (amountCents === null) e.amount = "Escriba un número, por ejemplo 1.250.000.";
    else if (amountCents <= 0) e.amount = "Tiene que ser mayor que cero.";
    if (short && !anyway) {
      e.qty = "No hay tanto en esa bodega. Corrija la cantidad o marque la casilla de abajo.";
    }
    setFields(e);
    return Object.keys(e).length === 0;
  }

  async function save() {
    if (!validate() || quantity === null || amountCents === null || !warehouse) return;
    // One sale per filled-in form. A double click used to write two, and the
    // id being minted inside the call meant the server's idempotency could
    // never recognise the second one as a retry. See `lib/writeOnce.ts`.
    const intent = ["venta", productId, warehouse.id ?? warehouse.name, quantity,
                    amountCents, date, customer?.id ?? customer?.name ?? ""].join("|");
    const outcome = await runOnce(intent, async (mint) => {
      setError(null);
      // Same as the movement dialog: the warehouse id is required on the
      // sale, so a name typed into the picker becomes a row first.
      const warehouseId = warehouse.id ?? (await api.createWarehouse(warehouse.name)).id;
      return api.createSale({
        id: mint(),
        productId,
        customerId: customer?.id ?? null,
        customerName: customer && !customer.id ? customer.name : undefined,
        warehouseId,
        quantity,
        amountCents,
        note: note.trim() || null,
        date,
        allowNegativeStock: anyway,
      });
    }).catch((e: unknown) => {
      // The server's own guard, in case the levels this screen loaded are
      // stale — somebody else may have sold the same sacks two minutes ago.
      if (e instanceof ApiError && e.code === "INSUFFICIENT_STOCK") {
        const have = e.details.onHand;
        setError(
          `${e.spanishMessage}${
            typeof have === "number" ? ` En bodega hay ${formatQuantity(have)}.` : ""
          }`,
        );
      } else {
        setError(messageFor(e));
      }
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    onSaved(outcome.value);
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Registrar venta</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Stack spacing={2.5} sx={{ mt: 1 }}>
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
            label="Bodega de la que sale"
            addWhat="la bodega"
            options={warehouses}
            value={warehouse}
            onChange={setWarehouse}
            error={fields.warehouse}
            required
          />

          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label={`Cantidad${product ? ` (${product.storageUnit})` : ""}`}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              error={!!fields.qty}
              helperText={
                fields.qty ??
                (available !== null && product
                  ? `En bodega hay ${formatQuantity(available)} ${product.storageUnit}.`
                  : undefined)
              }
              inputMode="decimal"
              fullWidth
              required
            />
            <TextField
              label="Valor total"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              error={!!fields.amount}
              helperText={
                fields.amount ??
                (unitPrice !== null && product
                  ? `${formatMoney(unitPrice)} por ${product.storageUnit.toLowerCase()}`
                  : "Lo que le pagaron por todo")
              }
              inputMode="decimal"
              fullWidth
              required
            />
          </Stack>

          {short && (
            <Alert severity="warning">
              La bodega dice que solo hay{" "}
              {available !== null && product
                ? `${formatQuantity(available)} ${product.storageUnit}`
                : "menos"}
              , y la venta saca {qty}. Puede que falte registrar una entrada.
              <FormControlLabel
                sx={{ display: "block", mt: 1 }}
                control={
                  <Checkbox checked={anyway} onChange={(e) => setAnyway(e.target.checked)} />
                }
                label="Regístrela de todos modos: la venta ocurrió y la bodega está desactualizada."
              />
            </Alert>
          )}

          {/* The levels never arrived. Say so, once, quietly — and do NOT
              claim a shortage, which is what an empty array used to produce
              for every product on the farm. */}
          {levels === null && productId !== "" && (
            <Alert severity="info" variant="outlined">
              No se pudieron consultar las existencias, así que esta pantalla no
              sabe cuánto hay en bodega. La venta se registra igual y el servidor
              hace su propia comprobación.
            </Alert>
          )}

          <CatalogPicker
            label="Cliente (opcional)"
            addWhat="el cliente"
            options={customers.map((c) => ({ id: c.id, name: c.name }))}
            value={customer}
            onChange={setCustomer}
            helperText="La cooperativa, un comprador… Si no está en la lista, escríbalo."
          />

          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <DateField label="Fecha" value={date} onChange={setDate} />
            <TextField
              label="Nota (opcional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              fullWidth
            />
          </Stack>

          <Typography variant="caption" color="text.secondary">
            Al guardar, el producto sale de la bodega en el mismo acto. La
            cantidad no se podrá modificar después: si queda mal, se anula la venta —lo
            que devuelve el producto a la bodega— y se registra de nuevo.
          </Typography>
          <Typography variant="caption" color="text.secondary">
            La foto del comprobante todavía no se puede adjuntar: el servidor aún no tiene
            dónde guardarla. Preferimos decirlo a poner una casilla que se traga el archivo.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button variant="contained" onClick={save} disabled={busy}>
          {busy ? "Guardando…" : "Registrar venta"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
