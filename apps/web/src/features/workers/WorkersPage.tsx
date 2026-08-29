import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Avatar, Box, Stack, Typography } from "@mui/material";
import { ModuleList, type Column, type StatusFilter } from "../../components/ModuleList";
import { PermissionDenied } from "../../components/Guards";
import { Money } from "../../components/Money";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { messageFor } from "../../api/errors";
import { formatDate } from "../../lib/dates";
import type { Worker } from "../../api/types";

export function WorkersPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, error, denied, reload } = useAsync(
    () => api.listWorkers({ status, q: search || undefined }),
    [status, search],
  );

  // The weigher gets a narrower row from the server: no document, no phone,
  // no balance. The table follows the payload rather than hiding columns,
  // which is the same distinction the API makes.
  const full = can("workers.readFull");

  const columns: Column<Worker>[] = useMemo(() => {
    const base: Column<Worker>[] = [
      {
        key: "name",
        header: "Empleado",
        render: (w) => (
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Avatar src={w.photoUrl ?? undefined} sx={{ width: 36, height: 36 }}>
              {w.name[0]}
            </Avatar>
            <Box>
              <Typography sx={{ fontWeight: 600 }}>
                {w.name} {w.lastName}
              </Typography>
              {full && (
                <Typography variant="caption" color="text.secondary">
                  {w.documentType} {w.documentNumber}
                </Typography>
              )}
            </Box>
          </Stack>
        ),
      },
    ];
    if (full) {
      base.push(
        { key: "phone", header: "Teléfono", render: (w) => w.phone ?? "—", secondary: true },
        { key: "city", header: "Ciudad", render: (w) => w.city ?? "—", secondary: true },
        {
          key: "since",
          header: "Desde",
          render: (w) => (w.startedAt ? formatDate(w.startedAt) : "—"),
          secondary: true,
        },
        {
          key: "balance",
          header: "Saldo",
          align: "right",
          render: (w) =>
            w.balanceCents === undefined ? (
              "—"
            ) : (
              <Money cents={w.balanceCents} colored={w.balanceCents !== 0} />
            ),
        },
      );
    }
    return base;
  }, [full]);

  if (denied) return <PermissionDenied moduleName="ver los empleados" />;

  const owed = (data ?? []).reduce((a, w) => a + Math.max(0, w.balanceCents ?? 0), 0);

  return (
    <Box>
      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      <ModuleList<Worker>
        title="Empleados"
        singular="empleado"
        plural="empleados"
        rows={data}
        error={error}
        columns={columns}
        getId={(w) => w.id}
        getName={(w) => `${w.name} ${w.lastName}`}
        isInactive={(w) => w.status === "inactive"}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por nombre o identificación"
        statusFilter={status}
        onStatusFilterChange={setStatus}
        onCreate={can("workers.write") ? () => navigate("/empleados/nuevo") : undefined}
        createLabel="Nuevo empleado"
        onRowClick={can("workers.profile") ? (w) => navigate(`/empleados/${w.id}`) : undefined}
        onEdit={can("workers.write") ? (w) => navigate(`/empleados/${w.id}/editar`) : undefined}
        extraActions={
          can("money.pay")
            ? (w) => [{ label: "Pagar empleado", onClick: () => navigate(`/empleados/${w.id}/pagar`) }]
            : undefined
        }
        onDeactivate={
          can("workers.delete")
            ? async (w) => {
                try {
                  await api.deactivateWorker(w.id);
                  reload();
                } catch (e) {
                  setActionError(messageFor(e));
                }
              }
            : undefined
        }
        onReactivate={
          can("workers.delete")
            ? async (w) => {
                await api.reactivateWorker(w.id);
                reload();
              }
            : undefined
        }
        emptyTitle="Todavía no hay empleados"
        emptyBody="Registre a las personas que trabajan en la finca. Cada una lleva su propio saldo y su historial."
        footer={
          data && full ? (
            <Stack direction="row" spacing={2}>
              <span>
                {data.length} {data.length === 1 ? "empleado" : "empleados"}
              </span>
              <span>
                Total a favor de los empleados: <Money cents={owed} variant="small" />
              </span>
            </Stack>
          ) : null
        }
      />
    </Box>
  );
}
