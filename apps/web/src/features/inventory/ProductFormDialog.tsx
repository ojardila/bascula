/**
 * RSP-019 / RSP-020: a name, a category, a storage unit. And NO QUANTITY.
 *
 * The absent field is the design. A product form with a "cantidad inicial" box
 * would be a stock set through the back door: the number would go in without a
 * reason, without a date and without a warehouse, and the first time it
 * disagreed with the movements there would be nothing to reconcile it against.
 * The way a new product gets its first quantity is the same way it gets every
 * later one — a movement, with a reason. The dialog says so at the bottom and
 * offers the button.
 */
import { useState } from "react";
import {
  Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack,
  TextField, Typography,
} from "@mui/material";
import { CatalogPicker, type CatalogValue } from "../../components/CatalogPicker";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { uuidv7 } from "../../lib/uuid";
import type { CatalogItem, Product } from "../../api/types";

export interface ProductFormDialogProps {
  open: boolean;
  /** Null to create. */
  product: Product | null;
  categories: CatalogItem[];
  storageUnits: CatalogItem[];
  onClose: () => void;
  onSaved: (p: Product) => void;
}

export function ProductFormDialog({
  open, product, categories, storageUnits, onClose, onSaved,
}: ProductFormDialogProps) {
  const [name, setName] = useState(product?.name ?? "");
  const [category, setCategory] = useState<CatalogValue | null>(
    product?.categoryId ? { id: product.categoryId, name: product.categoryName ?? "" } : null,
  );
  const [unit, setUnit] = useState<CatalogValue | null>(
    product ? { id: product.storageUnitId, name: product.storageUnit } : null,
  );
  const [note, setNote] = useState(product?.note ?? "");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Escriba el nombre del producto.";
    if (!unit) e.unit = "Elija en qué unidad se guarda: bulto, kilo, caja…";
    setFields(e);
    return Object.keys(e).length === 0;
  }

  async function save() {
    if (!validate() || !unit) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        id: product?.id ?? uuidv7(),
        name: name.trim(),
        // Id when it was picked, name when it was typed. The server's POST is
        // idempotent by lower(name), so "Bulto" typed twice is one row.
        categoryId: category?.id ?? undefined,
        categoryName: category && !category.id ? category.name : undefined,
        storageUnitId: unit.id ?? undefined,
        storageUnit: unit.id ? undefined : unit.name,
        note: note.trim() || null,
      };
      const saved = product
        ? await api.updateProduct(product.id, body)
        : await api.createProduct(body);
      onSaved(saved);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{product ? "Modificar producto" : "Nuevo producto"}</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Nombre"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={!!fields.name}
            helperText={fields.name}
            fullWidth
            required
            autoFocus
          />
          <CatalogPicker
            label="Categoría"
            addWhat="la categoría"
            options={categories}
            value={category}
            onChange={setCategory}
            helperText="Materia prima, producto procesado… Si no está, escríbala."
          />
          <CatalogPicker
            label="Unidad de almacenamiento"
            addWhat="la unidad"
            options={storageUnits}
            value={unit}
            onChange={setUnit}
            error={fields.unit}
            helperText="Bulto, kilo, caja… En esta unidad se cuentan las existencias."
            required
          />
          <TextField
            label="Nota (opcional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            fullWidth
            multiline
            minRows={2}
          />
          {!product && (
            <Typography variant="body2" color="text.secondary">
              No se pide cantidad inicial a propósito: las existencias salen de los
              movimientos. Al guardar, registre una <strong>cosecha</strong> o una{" "}
              <strong>compra</strong> y quedará dicho de dónde vino lo que hay en bodega.
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button variant="contained" onClick={save} disabled={busy}>
          {busy ? "Guardando…" : "Guardar producto"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
