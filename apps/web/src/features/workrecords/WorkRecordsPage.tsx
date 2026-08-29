import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Box, Chip, Stack, Typography } from "@mui/material";
import { ModuleList, type Column, type StatusFilter } from "../../components/ModuleList";
import { PermissionDenied } from "../../components/Guards";
import { Value } from "../harvest/Figures";
import { totalsOfRecords } from "../harvest/totals";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { messageFor } from "../../api/errors";
import { formatDateRange } from "../../lib/dates";
import { formatQuantity } from "../../lib/money";
import type { WorkRecord } from "../../api/types";

export function WorkRecordsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, error, denied, reload } = useAsync(
    () => api.listWorkRecords({ status, q: search || undefined }),
    [status, search],
  );

  const showMoney = can("money.read");

  const columns: Column<WorkRecord>[] = useMemo(() => {
    const cols: Column<WorkRecord>[] = [
      {
        key: "activity",
        header: "Actividad",
        render: (r) => (
          <Stack>
            <Typography sx={{ fontWeight: 600 }}>{r.activityName}</Typography>
            <Typography variant="caption" color="text.secondary">
              {r.workerName}
            </Typography>
          </Stack>
        ),
      },
      {
        key: "date",
        header: "Fecha",
        render: (r) => formatDateRange(r.dateFrom, r.dateTo),
      },
      {
        key: "plots",
        header: "Lotes y cultivos",
        secondary: true,
        render: (r) => (
          <Stack>
            <span>{r.plotNames.join(", ")}</span>
            <Typography variant="caption" color="text.secondary">
              {r.plotCropNames.join(", ")}
            </Typography>
          </Stack>
        ),
      },
      {
        key: "quantity",
        header: "Cantidad",
        align: "right",
        render: (r) =>
          r.payMode === "contract"
            ? "contrato"
            : `${formatQuantity(r.quantity)} ${r.unitLabel ?? ""}`,
      },
    ];
    if (showMoney) {
      cols.push({
        key: "amount",
        header: "Valor",
        align: "right",
        /**
         * `amountIsEstimate`, not `rateCents === null`. The server sends the
         * flag expressly, and the two are not the same question: a rate can be
         * absent for reasons that have nothing to do with whether the amount
         * is still moving. `<Value>` is the harvest module's, so an estimate
         * reads the same everywhere in the console.
         */
        render: (r) => <Value total={totalsOfRecords([r])} />,
      });
    }
    cols.push({
      key: "state",
      header: "Estado",
      render: (r) =>
        r.settled ? (
          <Chip size="small" label="liquidada" />
        ) : (
          <Chip size="small" color="warning" variant="outlined" label="pendiente" />
        ),
    });
    return cols;
  }, [showMoney]);

  if (denied) return <PermissionDenied moduleName="ver las labores" />;

  const pending = (data ?? []).filter((r) => !r.settled);
  // The whole point of the fold: on the seeded farm every unsettled labor is
  // priced by the week, so this total is 100% estimate and used to print as a
  // firm figure.
  const pendingTotals = totalsOfRecords(pending);

  return (
    <Box>
      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      <ModuleList<WorkRecord>
        title="Labores"
        singular="labor"
        plural="labores"
        rows={data}
        error={error}
        columns={columns}
        getId={(r) => r.id}
        getName={(r) => `${r.activityName} de ${r.workerName}`}
        isInactive={(r) => r.status === "inactive"}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por actividad, empleado o lote"
        statusFilter={status}
        onStatusFilterChange={setStatus}
        onCreate={can("workRecords.write") ? () => navigate("/labores/nueva") : undefined}
        createLabel="Registrar labor"
        onDeactivate={
          can("workRecords.write")
            ? async (r) => {
                try {
                  await api.deactivateWorkRecord(r.id);
                  reload();
                } catch (e) {
                  // A settled record answers 409: the settlement has to be
                  // voided first, and the message says so.
                  setActionError(messageFor(e));
                }
              }
            : undefined
        }
        emptyTitle="Todavía no hay labores"
        emptyBody="Una labor es el registro de que alguien ejecutó una actividad sobre un lote, en una fecha, por una cantidad."
        footer={
          showMoney && data ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <span>{pending.length} pendientes de liquidar ·</span>
              <Value total={pendingTotals} variant="small" align="flex-start" />
            </Stack>
          ) : null
        }
      />
    </Box>
  );
}
