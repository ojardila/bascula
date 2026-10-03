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
import { useCallback, useState } from "react";
import { Alert, Box, Chip, Stack, Typography } from "@mui/material";
import AgricultureIcon from "@mui/icons-material/Agriculture";
import TerrainIcon from "@mui/icons-material/Terrain";
import {
  ModuleList,
  type Column,
  type StatusFilter,
} from "../../components/ModuleList";
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
import type { Expense, ExpenseList } from "../../api/types";
import { affix } from "../../lib/affix";

function ExpenseTarget({ expense: e }: { readonly expense: Expense }) {
  if (e.target === "activity") {
    return (
      <Chip
        size="small"
        icon={<AgricultureIcon />}
        label={e.activityName ?? "actividad"}
        variant="outlined"
      />
    );
  }
  return (
    <Chip
      size="small"
      icon={<TerrainIcon />}
      label={`${e.plotName ?? "lote"}${affix(e.cropName, " · ")}`}
      variant="outlined"
    />
  );
}

/** What the total in the footer is about, which depends on the filter. */
function TotalSentence({
  status,
  liveCount,
  totalCents,
}: {
  readonly status: StatusFilter;
  readonly liveCount: number;
  readonly totalCents: number;
}) {
  if (status === "active") {
    return (
      <>
        Suman <strong>{formatMoney(totalCents)}</strong>.
      </>
    );
  }
  if (status === "all") {
    return (
      <>
        De esos, {count(liveCount, "sigue activo", "siguen activos")} y{" "}
        {liveCount === 1 ? "suma" : "suman"}{" "}
        <strong>{formatMoney(totalCents)}</strong>: un gasto dado de baja no es
        plata que la finca gastó, así que no entra en el total.
      </>
    );
  }
  return (
    <>
      Están todos dados de baja, así que no hay total: un gasto de baja no es
      plata que la finca gastó.
    </>
  );
}

const COLUMNS: Column<Expense>[] = [
  {
    key: "date",
    header: "Fecha",
    render: (e) => formatDate(e.date),
    width: 120,
  },
  {
    key: "concept",
    header: "Concepto",
    render: (e) => (
      <Stack>
        <Typography sx={{ fontWeight: 600 }}>{e.concept}</Typography>
        {e.note && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {e.note}
          </Typography>
        )}
      </Stack>
    ),
  },
  {
    key: "target",
    header: "Se carga a",
    render: (e) => <ExpenseTarget expense={e} />,
  },
  {
    key: "amount",
    header: "Valor",
    align: "right",
    render: (e) => <Money cents={e.amountCents} />,
  },
];

/**
 * ── THE FOOTER DESCRIBED A DIFFERENT SET FROM THE ONE ABOVE IT ──
 *
 * `GET /v1/expenses` returns `items` for whichever filter was asked
 * for, and `count`/`totalCents` counting ONLY the live rows — that is
 * what `handleListExpenses` does and what the mock does. It is the
 * right decision for the total: an expense taken out of service is
 * not money the farm spent.
 *
 * What was wrong was the footer, which read that `count` as though it
 * were the table's. With the filter on "Inactivas" the screen showed
 * twelve rows and, underneath, in the same sentence, "0 gastos, por
 * un total de $0". This is not a rounding error: it is two different
 * sets under one label, which is exactly what the audit kept finding
 * screen after screen.
 *
 * The footer now counts what is above it and, when the total is about
 * something else, says so in the same sentence.
 */
function ExpensesFooter({
  data,
  status,
}: {
  readonly data: ExpenseList;
  readonly status: StatusFilter;
}) {
  return (
    <>
      {count(data.items.length, "gasto", "gastos")} en esta lista.{" "}
      <TotalSentence
        status={status}
        liveCount={data.count}
        totalCents={data.totalCents}
      />{" "}
      Cada uno está cargado a una actividad o a un lote, así que lo que sí suma
      se puede desglosar por completo.
    </>
  );
}

interface WriteHandlers {
  onCreate?: () => void;
  onRowClick?: (e: Expense) => void;
  onEdit?: (e: Expense) => void;
  onDeactivate?: (e: Expense) => Promise<void>;
  onReactivate?: (e: Expense) => Promise<void>;
}

/** The list's write actions, or none at all for a session that may not write. */
function writeHandlers(
  canWrite: boolean,
  edit: (e: Expense | null) => void,
  runAction: (action: () => Promise<unknown>) => Promise<void>,
): WriteHandlers {
  if (!canWrite) return {};
  return {
    onCreate: () => edit(null),
    onRowClick: (e) => edit(e),
    onEdit: (e) => edit(e),
    onDeactivate: (e) => runAction(() => api.deactivateExpense(e.id)),
    onReactivate: (e) => runAction(() => api.reactivateExpense(e.id)),
  };
}

export function ExpensesPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [reloadTick, setReloadTick] = useState(0);
  const [editing, setEditing] = useState<Expense | null | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);
  const canWrite = can("expenses.write");

  const runAction = async (action: () => Promise<unknown>) => {
    try {
      await action();
      reload();
    } catch (err) {
      setActionError(messageFor(err));
    }
  };

  const { data, error, denied } = useAsync(
    () => api.listExpenses({ status, q: search || undefined }),
    [status, search, reloadTick],
  );
  const { data: activities } = useAsync(
    () => api.listActivities({ status: "active" }),
    [],
  );
  const { data: plots } = useAsync(
    () => api.listPlots({ status: "active" }),
    [],
  );

  if (denied) return <PermissionDenied moduleName="ver los gastos" />;

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

      <ModuleList<Expense>
        title="Gastos"
        singular="gasto"
        plural="gastos"
        rows={data?.items ?? null}
        error={error}
        columns={COLUMNS}
        getId={(e) => e.id}
        getName={(e) => e.concept}
        isInactive={(e) => e.status === "inactive"}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por concepto"
        statusFilter={status}
        onStatusFilterChange={setStatus}
        createLabel="Registrar gasto"
        /* The whole row, not just the unlabelled 30 px ⋮ you had to hit.
           The same action, with a target twenty times bigger. */
        {...writeHandlers(canWrite, setEditing, runAction)}
        emptyTitle="Todavía no hay gastos"
        emptyBody="Registre el primero. Cada gasto se carga a una actividad o a un lote, para que después se pueda saber en qué se fue la plata."
        footer={data ? <ExpensesFooter data={data} status={status} /> : null}
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
