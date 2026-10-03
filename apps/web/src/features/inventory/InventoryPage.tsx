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
 * changing it goes through "Registrar entrada o salida". See `StockMoveDialog` for
 * the argument; the short version is that this app treats a warehouse the way
 * it treats a wage: a total you can only reach by adding up what happened.
 */
import { useCallback, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import SwapVertIcon from "@mui/icons-material/SwapVert";
import UndoIcon from "@mui/icons-material/Undo";
import LabelIcon from "@mui/icons-material/Label";
import {
  ModuleList,
  type Column,
  type StatusFilter,
} from "../../components/ModuleList";
import { TableState } from "../../components/TableState";
import { PermissionDenied } from "../../components/Guards";
import { ProductFormDialog } from "./ProductFormDialog";
import { StockMoveDialog } from "./StockMoveDialog";
import { LabelSheetDialog } from "./LabelSheetDialog";
import { useAsync } from "../../lib/useAsync";
import { api, STOCK_MOVES_PAGE } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { formatQuantity } from "../../lib/money";
import { unitLabel } from "../../lib/plural";
import { formatDate } from "../../lib/dates";
import { formatSignedQty } from "../../lib/stock";
import { STOCK_MOVE } from "../../lib/vocab";
import {
  STOCK_REASON_LABEL,
  type LabelBatch,
  type Product,
  type StockLevel,
  type StockMove,
} from "../../api/types";

const COLUMNS: Column<Product>[] = [
  {
    key: "name",
    header: "Producto",
    render: (p) => (
      <Stack>
        <Typography sx={{ fontWeight: 600 }}>{p.name}</Typography>
        {p.note && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
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
  {
    key: "unit",
    header: "Unidad",
    render: (p) => p.storageUnit,
    secondary: true,
  },
  {
    key: "stock",
    header: "Existencias",
    align: "right",
    render: (p) => (
      <Tooltip title="Suma de las entradas y salidas registradas. No se escribe a mano.">
        <Stack
          sx={{
            alignItems: "flex-end",
          }}
        >
          <Typography sx={{ fontWeight: 600 }}>
            {/* "16 Bulto" was the catalogue value as-is, capitalised and
                singular. See `lib/plural.ts`. */}
            {formatQuantity(p.stock)} {unitLabel(p.stock, p.storageUnit)}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            de las entradas y salidas
          </Typography>
        </Stack>
      </Tooltip>
    ),
  },
];

/**
 * The list has been cut off at `STOCK_MOVES_PAGE` since it existed, and the
 * screen never said so: a warehouse with more than two hundred entries showed
 * the last two hundred as though they were all of them. `/cosecha` already
 * says this properly; this is the same thing, here.
 */
function TruncationNote({ moves }: { readonly moves: StockMove[] | null }) {
  if ((moves ?? []).length < STOCK_MOVES_PAGE) return null;
  return (
    <Typography
      variant="caption"
      component="div"
      sx={{
        color: "warning.dark",
        mt: 1,
      }}
    >
      Se muestran las {STOCK_MOVES_PAGE} más recientes. Puede haber más atrás.
    </Typography>
  );
}

interface LevelsCardProps {
  readonly levels: StockLevel[] | null;
  readonly error: string | null;
  readonly denied: boolean;
  readonly moves: StockMove[] | null;
}

function StockLevelsCard({ levels, error, denied, moves }: LevelsCardProps) {
  return (
    <Card>
      <CardContent>
        <Typography variant="h3" gutterBottom>
          Existencias por bodega
        </Typography>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            mb: 2,
          }}
        >
          Cada línea es una suma de entradas y salidas, calculada al momento de
          consultar.
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
              error={error}
              denied={denied}
              subject="las existencias"
              emptyText="Ninguna bodega tiene existencias todavía."
            />
          </TableBody>
        </Table>
        <TruncationNote moves={moves} />
      </CardContent>
    </Card>
  );
}

/** Only an ordinary movement can be corrected: not a correction, not a sale's. */
function canReverse(m: StockMove, writable: boolean): boolean {
  return writable && !m.reversedById && !m.reversesId && !m.saleId;
}

interface MoveRowProps {
  readonly move: StockMove;
  readonly writable: boolean;
  readonly onShowLabels: (batchId: string) => void;
  readonly onReverse: (move: StockMove) => void;
}

function MoveRow({ move: m, writable, onShowLabels, onReverse }: MoveRowProps) {
  return (
    <TableRow sx={{ opacity: m.reversedById ? 0.5 : 1 }}>
      <TableCell>{formatDate(m.date)}</TableCell>
      <TableCell>
        <Stack>
          {m.productName}
          {m.plotName && (
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
              }}
            >
              {m.plotName}
            </Typography>
          )}
        </Stack>
      </TableCell>
      <TableCell>
        <Stack
          direction="row"
          spacing={0.5}
          sx={{
            alignItems: "center",
          }}
        >
          <Chip size="small" label={STOCK_REASON_LABEL[m.reason]} />
          {m.reversesId && (
            <Chip size="small" label="corrección" color="warning" />
          )}
          {m.reversedById && <Chip size="small" label="corregido" />}
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
          <Tooltip title="Ver los stickers de esta entrada">
            <IconButton
              size="small"
              aria-label={`Stickers de la entrada de ${m.productName}`}
              onClick={() => onShowLabels(m.labelBatchId!)}
            >
              <LabelIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {canReverse(m, writable) && (
          <Tooltip title="Corregir esto con una entrada o salida contraria">
            <IconButton
              size="small"
              aria-label={`Corregir la entrada o salida de ${m.productName}`}
              onClick={() => onReverse(m)}
            >
              <UndoIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </TableCell>
    </TableRow>
  );
}

interface MovesCardProps {
  readonly moves: StockMove[] | null;
  readonly error: string | null;
  readonly denied: boolean;
  readonly writable: boolean;
  readonly onShowLabels: (batchId: string) => void;
  readonly onReverse: (move: StockMove) => void;
  readonly onCreate: () => void;
}

function StockMovesCard({
  moves,
  error,
  denied,
  writable,
  onShowLabels,
  onReverse,
  onCreate,
}: MovesCardProps) {
  return (
    <Card>
      <CardContent>
        <Typography variant="h3" gutterBottom>
          {STOCK_MOVE.Many}
        </Typography>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            mb: 2,
          }}
        >
          Lo que entró o salió no se modifica ni se borra: es un hecho. Si quedó
          mal, se registra una corrección, que es una salida igual a la entrada
          (o al revés) y la cancela exactamente.
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
              <MoveRow
                key={m.id}
                move={m}
                writable={writable}
                onShowLabels={onShowLabels}
                onReverse={onReverse}
              />
            ))}
            <TableState
              colSpan={6}
              rows={moves}
              error={error}
              denied={denied}
              subject={STOCK_MOVE.ofThem}
              emptyText="Todavía no ha entrado ni salido nada."
              emptyAction={
                writable ? (
                  <Button
                    startIcon={<AddIcon />}
                    sx={{ ml: 1 }}
                    onClick={onCreate}
                  >
                    Registrar el primero
                  </Button>
                ) : undefined
              }
            />
          </TableBody>
        </Table>
        <TruncationNote moves={moves} />
      </CardContent>
    </Card>
  );
}

interface ProductsTabProps {
  readonly products: Product[] | null;
  readonly error: string | null;
  readonly search: string;
  readonly onSearchChange: (q: string) => void;
  readonly status: StatusFilter;
  readonly onStatusChange: (s: StatusFilter) => void;
  readonly canEdit: boolean;
  readonly writable: boolean;
  readonly onEdit: (p: Product | null) => void;
  readonly onMove: (p: Product | null) => void;
  /**
   * Caught by the caller, not left to reject: `ModuleList` awaits these
   * inside a try/finally with no catch, so an unhandled rejection would close
   * the dialog and say nothing.
   */
  readonly onAction: (action: () => Promise<unknown>) => Promise<void>;
}

interface ProductWriteHandlers {
  onCreate?: () => void;
  onRowClick?: (p: Product) => void;
  onEdit?: (p: Product) => void;
  onDeactivate?: (p: Product) => Promise<void>;
  onReactivate?: (p: Product) => Promise<void>;
}

/** The catalogue's write actions, or none at all for a session that may not edit. */
function productWriteHandlers(
  canEdit: boolean,
  edit: (p: Product | null) => void,
  onAction: (action: () => Promise<unknown>) => Promise<void>,
): ProductWriteHandlers {
  if (!canEdit) return {};
  return {
    onCreate: () => edit(null),
    onRowClick: (p) => edit(p),
    onEdit: (p) => edit(p),
    onDeactivate: (p) => onAction(() => api.deactivateProduct(p.id)),
    onReactivate: (p) => onAction(() => api.reactivateProduct(p.id)),
  };
}

function ProductsTab({
  products,
  error,
  search,
  onSearchChange,
  status,
  onStatusChange,
  canEdit,
  writable,
  onEdit,
  onMove,
  onAction,
}: ProductsTabProps) {
  return (
    <ModuleList<Product>
      title="Inventario"
      singular="producto"
      plural="productos"
      rows={products}
      error={error}
      columns={COLUMNS}
      getId={(p) => p.id}
      getName={(p) => p.name}
      isInactive={(p) => p.status === "inactive"}
      search={search}
      onSearchChange={onSearchChange}
      searchPlaceholder="Buscar por nombre de producto"
      statusFilter={status}
      onStatusFilterChange={onStatusChange}
      createLabel="Nuevo producto"
      /* The whole row, not just the unlabelled 30 px ⋮ you had to hit.
       The same action, with a target twenty times bigger. */
      {...productWriteHandlers(canEdit, onEdit, onAction)}
      extraActions={
        writable
          ? (p) => [
              {
                label: `Registrar ${STOCK_MOVE.one}`,
                onClick: () => onMove(p),
              },
            ]
          : undefined
      }
      toolbarExtra={
        writable ? (
          <Button
            variant="outlined"
            startIcon={<SwapVertIcon />}
            onClick={() => onMove(null)}
          >
            Registrar entrada o salida
          </Button>
        ) : undefined
      }
      emptyTitle="Todavía no hay productos"
      emptyBody="Registre el primero: café pergamino, abono, fungicida… Después registre de dónde salió lo que hay en bodega."
      footer={
        <>
          Las existencias no son un dato que se escriba: son la suma de lo que
          ha entrado y salido de cada producto. Para cambiarlas, registre lo que
          pasó —una cosecha, una compra, un consumo, una merma o un ajuste con
          su explicación.
        </>
      }
    />
  );
}

export function InventoryPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [reloadTick, setReloadTick] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Product | null | undefined>(undefined);
  const [movingFor, setMovingFor] = useState<Product | null | undefined>(
    undefined,
  );
  const [batch, setBatch] = useState<LabelBatch | null>(null);

  const {
    data: products,
    error,
    denied,
  } = useAsync(
    () => api.listProducts({ status, q: search || undefined }),
    [status, search, reloadTick],
  );
  /**
   * Both errors are caught, and that is the entire fix for these two tabs:
   * without them a failed query left `levels` and `moves` null forever,
   * `(levels ?? []).map(...)` drew no rows at all, and the screen was left as
   * headers with nothing under them — which reads as an empty warehouse. See
   * `components/TableState.tsx`.
   */
  const {
    data: levels,
    error: levelsError,
    denied: levelsDenied,
  } = useAsync(() => api.stockLevels(), [reloadTick]);
  const {
    data: moves,
    error: movesError,
    denied: movesDenied,
  } = useAsync(
    () => api.listStockMoves({ limit: STOCK_MOVES_PAGE }),
    [reloadTick],
  );
  const { data: categories } = useAsync(() => api.productCategories(), []);
  const { data: units } = useAsync(() => api.storageUnits(), []);
  const { data: warehouses } = useAsync(() => api.warehouses(), [reloadTick]);
  const { data: plots } = useAsync(
    () => api.listPlots({ status: "active" }),
    [],
  );

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

  async function runAction(action: () => Promise<unknown>) {
    try {
      await action();
      reload();
    } catch (e) {
      setActionError(messageFor(e));
    }
  }

  function reverseMove(move: StockMove) {
    setActionError(null);
    return runAction(() =>
      api.reverseStockMove(move.id, "Corrección desde la consola"),
    );
  }

  async function showLabels(batchId: string) {
    try {
      // The batch that already exists, not a new one: reprinting must not
      // change the codes on the sacks.
      setBatch(await api.getLabelBatch(batchId));
    } catch (e) {
      setActionError(messageFor(e));
    }
  }

  return (
    <Box>
      {actionError && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          onClose={() => setActionError(null)}
        >
          {actionError}
        </Alert>
      )}

      <Tabs value={tab} onChange={(_, v) => setTab(v as number)} sx={{ mb: 3 }}>
        <Tab label="Productos" />
        <Tab label="Existencias por bodega" />
        <Tab label={STOCK_MOVE.Many} />
      </Tabs>

      {tab === 0 && (
        <ProductsTab
          products={products}
          error={error}
          search={search}
          onSearchChange={setSearch}
          status={status}
          onStatusChange={setStatus}
          canEdit={can("products.write")}
          writable={writable}
          onEdit={setEditing}
          onMove={setMovingFor}
          onAction={runAction}
        />
      )}

      {tab === 1 && (
        <StockLevelsCard
          levels={levels}
          error={levelsError}
          denied={levelsDenied}
          moves={moves}
        />
      )}

      {tab === 2 && (
        <StockMovesCard
          moves={moves}
          error={movesError}
          denied={movesDenied}
          writable={writable}
          onShowLabels={showLabels}
          onReverse={reverseMove}
          onCreate={() => setMovingFor(null)}
        />
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
