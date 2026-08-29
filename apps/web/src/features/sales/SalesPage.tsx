/**
 * RSP-026 … RSP-029, on the module template.
 *
 * ONE DEPARTURE FROM THE TEMPLATE, and it is deliberate. Every other module in
 * this console removes a row logically and offers "Reactivar". A sale does not
 * work that way: it took product out of a warehouse, so undoing it has to put
 * the product back, and that is a REVERSAL — a second movement — not a flag on
 * a row. So the row menu says "Anular la venta" and says what it will do, and
 * there is no way back from it other than recording the sale again.
 *
 * A voided sale stays visible, greyed. Hiding it would leave the warehouse
 * holding a reversal movement that points at something nobody can see.
 */
import { useCallback, useMemo, useState } from "react";
import { Alert, Box, Chip, Stack, Typography } from "@mui/material";
import { ModuleList, type Column, type StatusFilter } from "../../components/ModuleList";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { PermissionDenied } from "../../components/Guards";
import { SaleFormDialog } from "./SaleFormDialog";
import { Money } from "../../components/Money";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { formatMoney, formatQuantity } from "../../lib/money";
import { formatDate } from "../../lib/dates";
import type { Sale } from "../../api/types";

export function SalesPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [reloadTick, setReloadTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<Sale | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  const { data: sales, error, denied } = useAsync(
    () => api.listSales({ q: search || undefined, status }),
    [search, status, reloadTick],
  );
  const rows = sales?.items ?? null;
  const { data: products } = useAsync(() => api.listProducts({ status: "active" }), [reloadTick]);
  const { data: customers } = useAsync(() => api.listCustomers(), [reloadTick]);
  const { data: warehouses } = useAsync(() => api.warehouses(), []);
  const { data: levels } = useAsync(() => api.stockLevels(), [reloadTick]);

  // "Activas" means "not voided" here: `store.SaleFilter` embeds the same
  // `Filter` as every other list, keyed on `voided_at` instead of
  // `deleted_at`, so the three chips need no special case on this screen.
  /** The server's own sum over the live sales. Never added up here. */
  const total = sales?.totalCents ?? 0;
  const totalQty = sales?.totalQty ?? 0;

  const columns: Column<Sale>[] = useMemo(
    () => [
      {
        key: "date",
        header: "Fecha",
        render: (s) => formatDate(s.date),
        width: 120,
      },
      {
        key: "product",
        header: "Producto",
        render: (s) => (
          <Stack>
            <Typography sx={{ fontWeight: 600 }}>{s.productName}</Typography>
            <Typography variant="caption" color="text.secondary">
              {formatQuantity(s.quantity)} {s.storageUnit} · {s.warehouseName}
            </Typography>
          </Stack>
        ),
      },
      {
        key: "customer",
        header: "Cliente",
        render: (s) => s.customerName ?? "—",
        secondary: true,
      },
      {
        key: "amount",
        header: "Valor",
        align: "right",
        render: (s) => (
          <Stack alignItems="flex-end">
            <Money cents={s.amountCents} />
            {s.voided && <Chip size="small" label="anulada" sx={{ mt: 0.5 }} />}
          </Stack>
        ),
      },
    ],
    [],
  );

  if (denied) return <PermissionDenied moduleName="ver las ventas" />;

  async function voidSale() {
    if (!voiding) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.voidSale(voiding.id);
      setVoiding(null);
      reload();
    } catch (e) {
      setActionError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box>
      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      <ModuleList<Sale>
        title="Ventas"
        singular="venta"
        plural="ventas"
        rows={rows}
        error={error}
        columns={columns}
        getId={(s) => s.id}
        getName={(s) => `${s.productName} del ${formatDate(s.date)}`}
        isInactive={(s) => s.voided}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por producto o cliente"
        statusFilter={status}
        onStatusFilterChange={setStatus}
        onCreate={can("sales.write") ? () => setCreating(true) : undefined}
        createLabel="Registrar venta"
        extraActions={
          can("sales.write")
            ? (s) =>
                s.voided ? [] : [{ label: "Anular la venta", onClick: () => setVoiding(s) }]
            : undefined
        }
        emptyTitle="Todavía no hay ventas"
        emptyBody="Registre la primera. Al hacerlo, el producto sale de la bodega en el mismo movimiento."
        footer={
          <>
            {(rows ?? []).filter((s) => !s.voided).length} venta(s) sin anular, por un total
            de <strong>{formatMoney(total)}</strong>
            {totalQty > 0 && <> ({formatQuantity(totalQty)} unidades)</>}. Cada venta descuenta
            el producto de su bodega; anularla lo devuelve con un movimiento de reverso.
          </>
        }
      />

      {creating && (
        <SaleFormDialog
          open
          products={products ?? []}
          customers={customers ?? []}
          warehouses={warehouses ?? []}
          levels={levels ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            reload();
          }}
        />
      )}

      <ConfirmDialog
        open={!!voiding}
        busy={busy}
        title="¿Anular esta venta?"
        body={
          voiding
            ? `«${voiding.productName}» del ${formatDate(voiding.date)}. La venta queda registrada y marcada como anulada —no se borra— y ${formatQuantity(voiding.quantity)} ${voiding.storageUnit} vuelven a ${voiding.warehouseName} con un movimiento de reverso. Si el error fue la cantidad o el valor, después registre la venta correcta.`
            : ""
        }
        confirmLabel="Anular la venta"
        destructive
        onConfirm={voidSale}
        onCancel={() => setVoiding(null)}
      />
    </Box>
  );
}
