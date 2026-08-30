/**
 * RSP-018 … RSP-025, on the module template the other four screens use.
 *
 * Three tabs, because the module answers three different questions and one
 * table cannot: WHAT do we handle (products), HOW MUCH is where (levels), and
 * WHAT HAPPENED (movements). Only the first is a `ModuleList` — the other two
 * are derivations, and neither has rows anybody creates, edits or deactivates,
 * which is most of what that component is for.
 *
 * THE COLUMN THAT IS NOT EDITABLE. "Existencias" is a number with no pencil
 * next to it, and the footer says where it comes from. Every route into
 * changing it goes through "Registrar movimiento". See `StockMoveDialog` for
 * the argument; the short version is that this app treats a warehouse the way
 * it treats a wage: a total you can only reach by adding up what happened.
 */
import { useCallback, useMemo, useState } from "react";
import {
  Alert, Box, Button, Card, CardContent, Chip, IconButton, Stack, Tab, Table,
  TableBody, TableCell, TableHead, TableRow, Tabs, Tooltip, Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import SwapVertIcon from "@mui/icons-material/SwapVert";
import UndoIcon from "@mui/icons-material/Undo";
import LabelIcon from "@mui/icons-material/Label";
import { ModuleList, type Column, type StatusFilter } from "../../components/ModuleList";
import { TableState } from "../../components/TableState";
import { PermissionDenied } from "../../components/Guards";
import { ProductFormDialog } from "./ProductFormDialog";
import { StockMoveDialog } from "./StockMoveDialog";
import { LabelSheetDialog } from "./LabelSheetDialog";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { formatQuantity } from "../../lib/money";
import { unitLabel } from "../../lib/plural";
import { formatDate } from "../../lib/dates";
import { formatSignedQty } from "../../lib/stock";
import {
  STOCK_REASON_LABEL, type LabelBatch, type Product, type StockMove,
} from "../../api/types";

export function InventoryPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [reloadTick, setReloadTick] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Product | null | undefined>(undefined);
  const [movingFor, setMovingFor] = useState<Product | null | undefined>(undefined);
  const [batch, setBatch] = useState<LabelBatch | null>(null);

  const { data: products, error, denied } = useAsync(
    () => api.listProducts({ status, q: search || undefined }),
    [status, search, reloadTick],
  );
  /**
   * Los dos errores se capturan, y eso es el arreglo entero de estas dos
   * pestañas: sin ellos, una consulta caída dejaba `levels` y `moves` en null
   * para siempre, `(levels ?? []).map(...)` no pintaba ninguna fila, y la
   * pantalla quedaba en encabezados con nada debajo — que se lee como una
   * bodega vacía. Ver `components/TableState.tsx`.
   */
  const { data: levels, error: levelsError, denied: levelsDenied } = useAsync(
    () => api.stockLevels(),
    [reloadTick],
  );
  const { data: moves, error: movesError, denied: movesDenied } = useAsync(
    () => api.listStockMoves({ limit: 200 }),
    [reloadTick],
  );
  const { data: categories } = useAsync(() => api.productCategories(), []);
  const { data: units } = useAsync(() => api.storageUnits(), []);
  const { data: warehouses } = useAsync(() => api.warehouses(), [reloadTick]);
  const { data: plots } = useAsync(() => api.listPlots({ status: "active" }), []);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  /** What one product holds in one warehouse, for the movement preview. */
  const stockOf = useCallback(
    (productId: string, warehouseId: string | null): number | null => {
      if (!levels || !warehouseId) return null;
      const line = levels.find(
        (l) => l.productId === productId && l.warehouseId === warehouseId,
      );
      return line ? line.qty : 0;
    },
    [levels],
  );

  const columns: Column<Product>[] = useMemo(
    () => [
      {
        key: "name",
        header: "Producto",
        render: (p) => (
          <Stack>
            <Typography sx={{ fontWeight: 600 }}>{p.name}</Typography>
            {p.note && (
              <Typography variant="caption" color="text.secondary">
                {p.note}
              </Typography>
            )}
          </Stack>
        ),
      },
      {
        key: "category",
        header: "Categoría",
        render: (p) => p.categoryName ?? "—",
        secondary: true,
      },
      { key: "unit", header: "Unidad", render: (p) => p.storageUnit, secondary: true },
      {
        key: "stock",
        header: "Existencias",
        align: "right",
        render: (p) => (
          <Tooltip title="Suma de los movimientos registrados. No se escribe a mano.">
            <Stack alignItems="flex-end">
              <Typography sx={{ fontWeight: 600 }}>
                {/* «16 Bulto» era el catálogo tal cual, con su mayúscula y en
                    singular. Ver `lib/plural.ts`. */}
                {formatQuantity(p.stock)} {unitLabel(p.stock, p.storageUnit)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                de los movimientos
              </Typography>
            </Stack>
          </Tooltip>
        ),
      },
    ],
    [],
  );

  if (denied) return <PermissionDenied moduleName="ver el inventario" />;

  const writable = can("stock.write");

  /**
   * The sticker batch arrives WITH the movement — `POST /v1/stock/moves`
   * answers `{move, labelBatch}` — so there is no second call to make and no
   * window in which the coffee is in the warehouse and the labels are not.
   */
  function saveMove(_move: StockMove, labelBatch: LabelBatch | null) {
    setMovingFor(undefined);
    reload();
    if (labelBatch) setBatch(labelBatch);
  }

  async function reverseMove(move: StockMove) {
    setActionError(null);
    try {
      await api.reverseStockMove(move.id, "Corrección desde la consola");
      reload();
    } catch (e) {
      setActionError(messageFor(e));
    }
  }

  return (
    <Box>
      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      <Tabs value={tab} onChange={(_, v) => setTab(v as number)} sx={{ mb: 3 }}>
        <Tab label="Productos" />
        <Tab label="Existencias por bodega" />
        <Tab label="Movimientos" />
      </Tabs>

      {tab === 0 && (
        <ModuleList<Product>
          title="Inventario"
          singular="producto"
          plural="productos"
          rows={products}
          error={error}
          columns={columns}
          getId={(p) => p.id}
          getName={(p) => p.name}
          isInactive={(p) => p.status === "inactive"}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Buscar por nombre de producto"
          statusFilter={status}
          onStatusFilterChange={setStatus}
          onCreate={can("products.write") ? () => setEditing(null) : undefined}
          createLabel="Nuevo producto"
          /* La fila entera, no sólo el ⋮ de 30 px sin etiqueta que había
             que acertar. La misma acción, con un blanco veinte veces
             mayor. */
          onRowClick={can("products.write") ? (p) => setEditing(p) : undefined}
          onEdit={can("products.write") ? (p) => setEditing(p) : undefined}
          extraActions={
            writable
              ? (p) => [
                  { label: "Registrar movimiento", onClick: () => setMovingFor(p) },
                ]
              : undefined
          }
          onDeactivate={
            can("products.write")
              ? async (p) => {
                  // Caught here, not left to reject: `ModuleList` awaits this
                  // inside a try/finally with no catch, so an unhandled
                  // rejection would close the dialog and say nothing.
                  try {
                    await api.deactivateProduct(p.id);
                    reload();
                  } catch (e) {
                    setActionError(messageFor(e));
                  }
                }
              : undefined
          }
          onReactivate={
            can("products.write")
              ? async (p) => {
                  try {
                    await api.reactivateProduct(p.id);
                    reload();
                  } catch (e) {
                    setActionError(messageFor(e));
                  }
                }
              : undefined
          }
          toolbarExtra={
            writable ? (
              <Button
                variant="outlined"
                startIcon={<SwapVertIcon />}
                onClick={() => setMovingFor(null)}
              >
                Registrar movimiento
              </Button>
            ) : undefined
          }
          emptyTitle="Todavía no hay productos"
          emptyBody="Registre el primero: café pergamino, abono, fungicida… Después registre de dónde salió lo que hay en bodega."
          footer={
            <>
              Las existencias no son un dato que se escriba: son la suma de los movimientos
              de cada producto. Para cambiarlas, registre lo que pasó —una cosecha, una
              compra, un consumo, una merma o un ajuste con su explicación.
            </>
          }
        />
      )}

      {tab === 1 && (
        <Card>
          <CardContent>
            <Typography variant="h3" gutterBottom>
              Existencias por bodega
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Cada línea es una suma de movimientos, calculada al momento de consultar.
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Producto</TableCell>
                  <TableCell>Bodega</TableCell>
                  <TableCell align="right">Cantidad</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(levels ?? []).map((l) => (
                  <TableRow key={`${l.productId}-${l.warehouseId}`}>
                    <TableCell>{l.productName}</TableCell>
                    <TableCell>{l.warehouseName}</TableCell>
                    <TableCell align="right">
                      <Typography
                        component="span"
                        sx={{ fontWeight: 600 }}
                        color={l.qty < 0 ? "error.main" : undefined}
                      >
                        {formatQuantity(l.qty)} {unitLabel(l.qty, l.storageUnit)}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
                <TableState
                  colSpan={3}
                  rows={levels}
                  error={levelsError}
                  denied={levelsDenied}
                  subject="las existencias"
                  emptyText="Ninguna bodega tiene existencias todavía."
                />
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {tab === 2 && (
        <Card>
          <CardContent>
            <Typography variant="h3" gutterBottom>
              Movimientos
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Un movimiento no se modifica ni se borra: es un hecho. Si quedó mal, se
              registra el reverso, que es un movimiento que lo cancela exactamente.
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Fecha</TableCell>
                  <TableCell>Producto</TableCell>
                  <TableCell>Motivo</TableCell>
                  <TableCell>Bodega</TableCell>
                  <TableCell align="right">Cantidad</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {(moves ?? []).map((m) => (
                  <TableRow key={m.id} sx={{ opacity: m.reversedById ? 0.5 : 1 }}>
                    <TableCell>{formatDate(m.date)}</TableCell>
                    <TableCell>
                      <Stack>
                        {m.productName}
                        {m.plotName && (
                          <Typography variant="caption" color="text.secondary">
                            {m.plotName}
                          </Typography>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <Chip size="small" label={STOCK_REASON_LABEL[m.reason]} />
                        {m.reversesId && <Chip size="small" label="reverso" color="warning" />}
                        {m.reversedById && <Chip size="small" label="reversado" />}
                        {m.saleId && <Chip size="small" label="de una venta" />}
                      </Stack>
                    </TableCell>
                    <TableCell>{m.warehouseName}</TableCell>
                    <TableCell align="right">
                      <Typography
                        component="span"
                        sx={{ fontWeight: 600 }}
                        color={m.qty < 0 ? "error.main" : "success.main"}
                      >
                        {formatSignedQty(m.qty)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      {m.labelBatchId && (
                        <Tooltip title="Ver los stickers de este movimiento">
                          <IconButton
                            size="small"
                            aria-label={`Stickers del movimiento de ${m.productName}`}
                            onClick={async () => {
                              try {
                                // The batch that already exists, not a new one:
                                // reprinting must not change the codes on the
                                // sacks.
                                setBatch(await api.getLabelBatch(m.labelBatchId!));
                              } catch (e) {
                                setActionError(messageFor(e));
                              }
                            }}
                          >
                            <LabelIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                      {writable && !m.reversedById && !m.reversesId && !m.saleId && (
                        <Tooltip title="Registrar el reverso de este movimiento">
                          <IconButton
                            size="small"
                            aria-label={`Reversar el movimiento de ${m.productName}`}
                            onClick={() => reverseMove(m)}
                          >
                            <UndoIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                <TableState
                  colSpan={6}
                  rows={moves}
                  error={movesError}
                  denied={movesDenied}
                  subject="los movimientos"
                  emptyText="Todavía no hay movimientos registrados."
                  emptyAction={
                    writable ? (
                      <Button
                        startIcon={<AddIcon />}
                        sx={{ ml: 1 }}
                        onClick={() => setMovingFor(null)}
                      >
                        Registrar el primero
                      </Button>
                    ) : undefined
                  }
                />
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {editing !== undefined && (
        <ProductFormDialog
          open
          product={editing}
          categories={categories ?? []}
          storageUnits={units ?? []}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            reload();
          }}
        />
      )}

      {movingFor !== undefined && (
        <StockMoveDialog
          open
          product={movingFor}
          products={(products ?? []).filter((p) => p.status === "active")}
          warehouses={warehouses ?? []}
          plots={plots ?? []}
          stockOf={stockOf}
          onClose={() => setMovingFor(undefined)}
          onSaved={saveMove}
        />
      )}

      <LabelSheetDialog batch={batch} onClose={() => setBatch(null)} />
    </Box>
  );
}
