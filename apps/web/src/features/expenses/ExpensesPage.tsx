/**
 * RSP-030 … RSP-033, on the module template.
 *
 * The one thing this list does that the others do not is show WHAT each row is
 * charged to, in its own column, with the two kinds visibly different. That is
 * not decoration: the whole value of `expense_target` is that every peso lands
 * in exactly one bucket, and a list that only showed concept and amount would
 * make it impossible to notice that everything for three weeks went to
 * "Mantenimiento" because that was the first option in the select.
 *
 * The total comes from the server (`ExpenseTotals`), not from summing the rows
 * here: a total added up in the browser is the total of whatever happened to
 * load.
 */
import { useCallback, useMemo, useState } from "react";
import { Alert, Box, Chip, Stack, Typography } from "@mui/material";
import AgricultureIcon from "@mui/icons-material/Agriculture";
import TerrainIcon from "@mui/icons-material/Terrain";
import { ModuleList, type Column, type StatusFilter } from "../../components/ModuleList";
import { PermissionDenied } from "../../components/Guards";
import { ExpenseFormDialog } from "./ExpenseFormDialog";
import { Money } from "../../components/Money";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { formatMoney } from "../../lib/money";
import { count } from "../../lib/plural";
import { formatDate } from "../../lib/dates";
import type { Expense } from "../../api/types";

export function ExpensesPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [reloadTick, setReloadTick] = useState(0);
  const [editing, setEditing] = useState<Expense | null | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  const { data, error, denied } = useAsync(
    () => api.listExpenses({ status, q: search || undefined }),
    [status, search, reloadTick],
  );
  const { data: activities } = useAsync(() => api.listActivities({ status: "active" }), []);
  const { data: plots } = useAsync(() => api.listPlots({ status: "active" }), []);

  const columns: Column<Expense>[] = useMemo(
    () => [
      { key: "date", header: "Fecha", render: (e) => formatDate(e.date), width: 120 },
      {
        key: "concept",
        header: "Concepto",
        render: (e) => (
          <Stack>
            <Typography sx={{ fontWeight: 600 }}>{e.concept}</Typography>
            {e.note && (
              <Typography variant="caption" color="text.secondary">
                {e.note}
              </Typography>
            )}
          </Stack>
        ),
      },
      {
        key: "target",
        header: "Se carga a",
        render: (e) =>
          e.target === "activity" ? (
            <Chip
              size="small"
              icon={<AgricultureIcon />}
              label={e.activityName ?? "actividad"}
              variant="outlined"
            />
          ) : (
            <Chip
              size="small"
              icon={<TerrainIcon />}
              label={`${e.plotName ?? "lote"}${e.cropName ? ` · ${e.cropName}` : ""}`}
              variant="outlined"
            />
          ),
      },
      {
        key: "amount",
        header: "Valor",
        align: "right",
        render: (e) => <Money cents={e.amountCents} />,
      },
    ],
    [],
  );

  if (denied) return <PermissionDenied moduleName="ver los gastos" />;

  return (
    <Box>
      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      <ModuleList<Expense>
        title="Gastos"
        singular="gasto"
        plural="gastos"
        rows={data?.items ?? null}
        error={error}
        columns={columns}
        getId={(e) => e.id}
        getName={(e) => e.concept}
        isInactive={(e) => e.status === "inactive"}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por concepto"
        statusFilter={status}
        onStatusFilterChange={setStatus}
        onCreate={can("expenses.write") ? () => setEditing(null) : undefined}
        createLabel="Registrar gasto"
        /* La fila entera, no sólo el ⋮ de 30 px sin etiqueta que había
           que acertar. La misma acción, con un blanco veinte veces
           mayor. */
        onRowClick={can("expenses.write") ? (e) => setEditing(e) : undefined}
        onEdit={can("expenses.write") ? (e) => setEditing(e) : undefined}
        onDeactivate={
          can("expenses.write")
            ? async (e) => {
                try {
                  await api.deactivateExpense(e.id);
                  reload();
                } catch (err) {
                  setActionError(messageFor(err));
                }
              }
            : undefined
        }
        onReactivate={
          can("expenses.write")
            ? async (e) => {
                try {
                  await api.reactivateExpense(e.id);
                  reload();
                } catch (err) {
                  setActionError(messageFor(err));
                }
              }
            : undefined
        }
        emptyTitle="Todavía no hay gastos"
        emptyBody="Registre el primero. Cada gasto se carga a una actividad o a un lote, para que después se pueda saber en qué se fue la plata."
        /**
         * ── EL PIE DESCRIBÍA UN CONJUNTO DISTINTO DEL QUE SE VE ENCIMA ──
         *
         * `GET /v1/expenses` devuelve `items` según el filtro que se pidió, y
         * `count`/`totalCents` contando SÓLO las filas vivas — así lo hace
         * `handleListExpenses` y así lo hace el mock. Es la decisión correcta
         * para el total: un gasto dado de baja no es plata que la finca gastó.
         *
         * Lo que estaba mal era el pie, que leía ese `count` como si fuera el
         * de la tabla. Con el filtro en «Inactivas» la pantalla enseñaba doce
         * filas y debajo, en la misma frase, «0 gastos, por un total de $0».
         * No es un redondeo: son dos conjuntos distintos con una sola
         * etiqueta, que es exactamente lo que la auditoría vino encontrando
         * pantalla por pantalla.
         *
         * Ahora el pie cuenta lo que hay encima y, cuando el total va de otra
         * cosa, lo dice en la misma frase.
         */
        footer={
          data ? (
            <>
              {count(data.items.length, "gasto", "gastos")} en esta lista.{" "}
              {status === "active" ? (
                <>
                  Suman <strong>{formatMoney(data.totalCents)}</strong>.
                </>
              ) : status === "all" ? (
                <>
                  De esos, {count(data.count, "sigue activo", "siguen activos")} y{" "}
                  {data.count === 1 ? "suma" : "suman"}{" "}
                  <strong>{formatMoney(data.totalCents)}</strong>: un gasto dado de baja no
                  es plata que la finca gastó, así que no entra en el total.
                </>
              ) : (
                <>
                  Están todos dados de baja, así que no hay total: un gasto de baja no es
                  plata que la finca gastó.
                </>
              )}{" "}
              Cada uno está cargado a una actividad o a un lote, así que lo que sí suma se
              puede desglosar por completo.
            </>
          ) : null
        }
      />

      {editing !== undefined && (
        <ExpenseFormDialog
          open
          expense={editing}
          activities={activities ?? []}
          plots={plots ?? []}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            reload();
          }}
        />
      )}
    </Box>
  );
}
