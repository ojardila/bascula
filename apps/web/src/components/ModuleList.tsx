/**
 * One list screen, used by every module.
 *
 * There are ten modules coming and four of them exist already. Writing the
 * same table, the same search box, the same "+ Nuevo" button and the same
 * are-you-sure dialog ten times is not slow, it is *divergent*: by the third
 * copy the confirmation wording differs, by the fifth one of them hard-deletes.
 * `plan-sprint-1.md` makes this component an acceptance criterion for any
 * module PR, and this is it.
 *
 * What it owns, so no screen has to decide again:
 *  - the toolbar layout of cropti/farmlogs: search left, filter, primary
 *    action top-right, exactly one primary action per screen;
 *  - the "Activas" default filter, with inactive rows dimmed and *present* —
 *    removal is logical and a row that vanishes looks deleted;
 *  - the row menu, with destructive actions hidden (not disabled) when the
 *    role cannot use them: pass no callback and the item does not render;
 *  - loading, empty, error and "your search matched nothing" as four distinct
 *    states, because "no hay lotes" when the search is at fault is how a
 *    user concludes the data is gone.
 */
import { useState, type ReactNode } from "react";
import {
  Alert, Box, Button, Card, Chip, CircularProgress, IconButton, InputAdornment,
  Menu, MenuItem, Paper, Skeleton, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, ToggleButton,
  ToggleButtonGroup, Typography,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import AddIcon from "@mui/icons-material/Add";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import { ConfirmDialog } from "./ConfirmDialog";

export type StatusFilter = "active" | "inactive" | "all";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  width?: number | string;
  /** Hidden below ~900px, so the phone-sized view keeps the useful columns. */
  secondary?: boolean;
}

export interface ModuleListProps<T> {
  title: string;
  /** "lote", "empleado" — used to write the confirmation sentence. */
  singular: string;
  plural: string;
  rows: T[] | null;
  error?: string | null;
  columns: Column<T>[];
  getId: (row: T) => string;
  getName: (row: T) => string;
  isInactive: (row: T) => boolean;

  search: string;
  onSearchChange: (v: string) => void;
  searchPlaceholder: string;

  statusFilter: StatusFilter;
  onStatusFilterChange: (v: StatusFilter) => void;

  /** Omit to hide the primary button: the role cannot create. */
  onCreate?: () => void;
  createLabel?: string;

  onRowClick?: (row: T) => void;
  onEdit?: (row: T) => void;
  /** Omit to hide the option. Only the owner deactivates, per the role table. */
  onDeactivate?: (row: T) => Promise<void> | void;
  onReactivate?: (row: T) => Promise<void> | void;
  extraActions?: (row: T) => Array<{ label: string; onClick: () => void }>;

  footer?: ReactNode;
  emptyTitle?: string;
  emptyBody?: string;
  toolbarExtra?: ReactNode;
}

export function ModuleList<T>(props: ModuleListProps<T>) {
  const {
    title, singular, plural, rows, error, columns, getId, getName, isInactive,
    search, onSearchChange, searchPlaceholder, statusFilter, onStatusFilterChange,
    onCreate, createLabel, onRowClick, onEdit, onDeactivate, onReactivate,
    extraActions, footer, emptyTitle, emptyBody, toolbarExtra,
  } = props;

  const [menuFor, setMenuFor] = useState<{ el: HTMLElement; row: T } | null>(null);
  const [confirming, setConfirming] = useState<{ row: T; kind: "off" | "on" } | null>(null);
  const [busy, setBusy] = useState(false);

  const loading = rows === null;
  const empty = !loading && rows.length === 0;
  const searching = search.trim().length > 0;

  async function runConfirmed() {
    if (!confirming) return;
    setBusy(true);
    try {
      if (confirming.kind === "off") await onDeactivate?.(confirming.row);
      else await onReactivate?.(confirming.row);
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "stretch", sm: "center" }}
        spacing={2}
        sx={{ mb: 2 }}
      >
        <Typography variant="h1">{title}</Typography>
        {onCreate && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={onCreate}>
            {createLabel ?? `Nueva ${singular}`}
          </Button>
        )}
      </Stack>

      <Card>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={2}
          alignItems={{ xs: "stretch", md: "center" }}
          sx={{ p: 2, borderBottom: 1, borderColor: "divider" }}
        >
          <TextField
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            fullWidth
            sx={{ maxWidth: { md: 420 } }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
            inputProps={{ "aria-label": searchPlaceholder }}
          />
          <ToggleButtonGroup
            size="small"
            exclusive
            value={statusFilter}
            onChange={(_, v) => v && onStatusFilterChange(v as StatusFilter)}
            aria-label="Filtrar por estado"
          >
            <ToggleButton value="active">Activas</ToggleButton>
            <ToggleButton value="inactive">Inactivas</ToggleButton>
            <ToggleButton value="all">Todas</ToggleButton>
          </ToggleButtonGroup>
          <Box sx={{ flex: 1 }} />
          {toolbarExtra}
        </Stack>

        {error && (
          <Alert severity="error" sx={{ m: 2 }}>
            {error}
          </Alert>
        )}

        <TableContainer component={Paper} elevation={0}>
          <Table size="medium">
            <TableHead>
              <TableRow>
                {columns.map((c) => (
                  <TableCell
                    key={c.key}
                    align={c.align}
                    sx={{
                      width: c.width,
                      ...(c.secondary ? { display: { xs: "none", md: "table-cell" } } : {}),
                    }}
                  >
                    {c.header}
                  </TableCell>
                ))}
                <TableCell width={56} />
              </TableRow>
            </TableHead>
            <TableBody>
              {loading &&
                [0, 1, 2].map((i) => (
                  <TableRow key={i}>
                    {columns.map((c) => (
                      <TableCell key={c.key}>
                        <Skeleton />
                      </TableCell>
                    ))}
                    <TableCell />
                  </TableRow>
                ))}

              {!loading &&
                rows.map((row) => {
                  const inactive = isInactive(row);
                  return (
                    <TableRow
                      key={getId(row)}
                      hover={!!onRowClick}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      sx={{
                        cursor: onRowClick ? "pointer" : "default",
                        opacity: inactive ? 0.55 : 1,
                      }}
                    >
                      {columns.map((c) => (
                        <TableCell
                          key={c.key}
                          align={c.align}
                          sx={c.secondary ? { display: { xs: "none", md: "table-cell" } } : undefined}
                        >
                          {c.render(row)}
                        </TableCell>
                      ))}
                      <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                        <IconButton
                          size="small"
                          aria-label={`Acciones de ${getName(row)}`}
                          onClick={(e) => setMenuFor({ el: e.currentTarget, row })}
                        >
                          <MoreVertIcon fontSize="small" />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  );
                })}

              {empty && (
                <TableRow>
                  <TableCell colSpan={columns.length + 1} sx={{ py: 8, textAlign: "center" }}>
                    <Typography variant="h3" color="text.secondary" gutterBottom>
                      {searching
                        ? "Ningún resultado para esa búsqueda"
                        : (emptyTitle ?? `Todavía no hay ${plural}`)}
                    </Typography>
                    <Typography color="text.secondary" sx={{ mb: 2 }}>
                      {searching
                        ? "Pruebe con otro nombre, o cambie el filtro de estado."
                        : (emptyBody ?? "Use el botón de arriba para crear el primero.")}
                    </Typography>
                    {!searching && onCreate && (
                      <Button variant="outlined" startIcon={<AddIcon />} onClick={onCreate}>
                        {createLabel ?? `Nueva ${singular}`}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>

        {footer && (
          <Box
            sx={{
              px: 2, py: 1.5, borderTop: 1, borderColor: "divider",
              color: "text.secondary", fontSize: 14,
            }}
          >
            {footer}
          </Box>
        )}
      </Card>

      <Menu
        anchorEl={menuFor?.el ?? null}
        open={!!menuFor}
        onClose={() => setMenuFor(null)}
      >
        {menuFor && onRowClick && (
          <MenuItem
            onClick={() => {
              onRowClick(menuFor.row);
              setMenuFor(null);
            }}
          >
            Ver detalle
          </MenuItem>
        )}
        {menuFor && onEdit && (
          <MenuItem
            onClick={() => {
              onEdit(menuFor.row);
              setMenuFor(null);
            }}
          >
            Editar
          </MenuItem>
        )}
        {menuFor &&
          extraActions?.(menuFor.row).map((a) => (
            <MenuItem
              key={a.label}
              onClick={() => {
                a.onClick();
                setMenuFor(null);
              }}
            >
              {a.label}
            </MenuItem>
          ))}
        {menuFor && onDeactivate && !isInactive(menuFor.row) && (
          <MenuItem
            onClick={() => {
              setConfirming({ row: menuFor.row, kind: "off" });
              setMenuFor(null);
            }}
          >
            Dar de baja
          </MenuItem>
        )}
        {menuFor && onReactivate && isInactive(menuFor.row) && (
          <MenuItem
            onClick={() => {
              setConfirming({ row: menuFor.row, kind: "on" });
              setMenuFor(null);
            }}
          >
            Reactivar
          </MenuItem>
        )}
      </Menu>

      <ConfirmDialog
        open={!!confirming}
        busy={busy}
        /**
         * Sin artículo: `singular === "labor" ? "la" : "el"` escribía «¿Dar
         * de baja el actividad?», porque el género de un sustantivo no se
         * deduce de una lista de un elemento. El nombre propio se lee mejor
         * de todos modos — es el que la persona está mirando en la fila.
         */
        title={
          confirming
            ? `${confirming.kind === "off" ? "¿Dar de baja" : "¿Reactivar"} «${getName(
                confirming.row,
              )}»?`
            : ""
        }
        body={
          confirming?.kind === "off"
            ? `«${confirming ? getName(confirming.row) : ""}» queda inactiva y deja de aparecer en las listas y en los formularios. No se borra nada: su historial se conserva y puede reactivarla cuando quiera.`
            : `«${confirming ? getName(confirming.row) : ""}» vuelve a estar disponible en las listas y en los formularios.`
        }
        confirmLabel={confirming?.kind === "off" ? "Dar de baja" : "Reactivar"}
        /**
         * ── EL ROJO ERA PARA LO REVERSIBLE ─────────────────────────────
         *
         * Dar de baja se deshace con «Reactivar», que está en el mismo menú.
         * Pagar $338.100 no se deshace: queda escrito en el libro. Y hasta
         * este sprint el único botón rojo de la consola guardaba el primero
         * mientras el segundo era un clic verde.
         *
         * El rojo se queda para lo que no tiene vuelta —anular una
         * liquidación— y esto pregunta en el tono que le corresponde: sigue
         * habiendo diálogo, porque una lista que cambia sola tampoco está
         * bien, pero ya no grita.
         */
        destructive={false}
        onConfirm={runConfirmed}
        onCancel={() => setConfirming(null)}
      />

      {busy && (
        <Box sx={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}>
          <Chip icon={<CircularProgress size={14} />} label="Guardando…" />
        </Box>
      )}
    </Box>
  );
}
