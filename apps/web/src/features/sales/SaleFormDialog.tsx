/**
 * RSP-027: producto, cantidad, valor, cliente, foto del comprobante.
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
import { uuidv7 } from "../../lib/uuid";
import { formatMoney, formatQuantity, parseMoneyInput, parseQuantityInput } from "../../lib/money";
import { todayInFarm } from "../../lib/dates";
import { exceedsStock } from "../../lib/stock";
import { useAuth } from "../../auth/AuthContext";
import type { CatalogItem, Customer, Product, Sale, StockLevel } from "../../api/types";

export interface SaleFormDialogProps {
  open: boolean;
  products: Product[];
  customers: Customer[];
  warehouses: CatalogItem[];
  levels: StockLevel[];
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
  const [busy, setBusy] = useState(false);

  const product = products.find((p) => p.id === productId) ?? null;
  const quantity = parseQuantityInput(qty);
  const amountCents = parseMoneyInput(amount);

  const available = useMemo(() => {
    if (!productId || !warehouse?.id) return null;
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
    setBusy(true);
    setError(null);
    try {
      // Same as the movement dialog: the warehouse id is required on the
      // sale, so a name typed into the picker becomes a row first.
      const warehouseId = warehouse.id ?? (await api.createWarehouse(warehouse.name)).id;
      const sale = await api.createSale({
        id: uuidv7(),
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
      onSaved(sale);
    } catch (e) {
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
    } finally {
      setBusy(false);
    }
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

          <CatalogPicker
            label="Cliente (opcional)"
            addWhat="el cliente"
            options={customers.map((c) => ({ id: c.id, name: c.name }))}
            value={customer}
            onChange={setCustomer}
            helperText="La cooperativa, un comprador… Si no está en la lista, escríbalo."
          />

          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label="Fecha"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              fullWidth
            />
            <TextField
              label="Nota (opcional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              fullWidth
            />
          </Stack>

          <Typography variant="caption" color="text.secondary">
            Al guardar se descuenta el producto de la bodega en el mismo movimiento. La
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
