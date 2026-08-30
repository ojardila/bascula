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
import { useWriteOnce } from "../../lib/writeOnce";
import { useAuth } from "../../auth/AuthContext";
import { formatMoney, formatQuantity } from "../../lib/money";
import { count, unitLabel } from "../../lib/plural";
import { formatDate } from "../../lib/dates";
import type { Sale } from "../../api/types";

export function SalesPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [reloadTick, setReloadTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<Sale | null>(null);
  const { busy, run: runOnce } = useWriteOnce();
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

  /**
   * ── «N UNIDADES» SUMABA COSAS QUE NO SON LA MISMA COSA ────────────────
   *
   * `totalQty` is a plain sum of every sale's `quantity`, and a quantity is in
   * ITS PRODUCT'S storage unit: bultos of parchment, kilos of cherry, cajas of
   * avocado. Adding them gives a number with no unit and no meaning — 12
   * bultos plus 400 kilos is not 412 of anything — and the footer presented it
   * as "412 unidades".
   *
   * So it is shown only when every live sale is measured the same way, and
   * then it is shown WITH that unit. Mixed units get no total, because there
   * isn't one; the pesos below it are the figure that always adds up.
   */
  const liveSales = (sales?.items ?? []).filter((s) => !s.voided);
  const units = new Set(liveSales.map((s) => s.storageUnit).filter(Boolean));
  const oneUnit = units.size === 1 ? [...units][0] : null;

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
    // A DELETE on a resource id needs no client-minted id, so the data was
    // never at risk here. The guard is still worth having: the second click
    // otherwise earns a 409 ALREADY_VOIDED and an error box, for an action
    // that in fact succeeded.
    const id = voiding.id;
    const outcome = await runOnce(`anular-venta|${id}`, async () => {
      setActionError(null);
      return api.voidSale(id);
    }).catch((e: unknown) => {
      setActionError(messageFor(e));
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    setVoiding(null);
    reload();
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
        emptyBody="Registre la primera. Al hacerlo, el producto sale de la bodega en el mismo acto."
        /**
         * NOTHING AT ALL UNTIL THE LIST HAS LOADED.
         *
         * With the server down this read "0 venta(s) sin anular, por un total
         * de $0" — directly under the alert saying the server could not be
         * contacted. Two contradictory statements, one of which is a figure a
         * farm can genuinely have, in the same card. `rows ?? []` and
         * `sales?.totalCents ?? 0` are where both zeros came from: they are
         * fine for arithmetic and fatal for a sentence.
         */
        footer={
          sales ? (
            <>
              {count(liveSales.length, "venta sin anular", "ventas sin anular")}, por un total
              de <strong>{formatMoney(total)}</strong>
              {totalQty > 0 && oneUnit && (
                <> ({formatQuantity(totalQty)} {unitLabel(totalQty, oneUnit)})</>
              )}. Cada venta descuenta
              el producto de su bodega; anularla lo devuelve con una entrada de corrección.
            </>
          ) : null
        }
      />

      {creating && (
        <SaleFormDialog
          open
          products={products ?? []}
          customers={customers ?? []}
          warehouses={warehouses ?? []}
          // NOT `levels ?? []`: an empty array says every warehouse is empty,
          // which turns a failed stock request into a shortage warning on
          // every sale — and the only way past that warning is the checkbox
          // that disables the server's own guard.
          levels={levels}
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
            ? `«${voiding.productName}» del ${formatDate(voiding.date)}. La venta queda registrada y marcada como anulada —no se borra— y ${formatQuantity(voiding.quantity)} ${voiding.storageUnit} vuelven a ${voiding.warehouseName} con una entrada de corrección. Si el error fue la cantidad o el valor, después registre la venta correcta.`
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
