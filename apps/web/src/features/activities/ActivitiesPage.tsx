import { useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Alert, Box, Chip, Link, Stack, Tooltip, Typography } from "@mui/material";
import { ModuleList, type Column, type StatusFilter } from "../../components/ModuleList";
import { PermissionDenied } from "../../components/Guards";
import { Money } from "../../components/Money";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { messageFor } from "../../api/errors";
import { ActivityFormDialog } from "./ActivityFormDialog";
import { PAY_MODE_LABEL, PROVISIONAL, PROVISIONAL_WHY } from "../../lib/vocab";
import type { Activity } from "../../api/types";

/** Categories come from the farm's catalogue, so they are only capitalised. */
const titleCase = (s: string) => (s ? s[0].toLocaleUpperCase("es") + s.slice(1) : s);

export function ActivitiesPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [editing, setEditing] = useState<Activity | null | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, error, denied, reload } = useAsync(
    () => api.listActivities({ status, q: search || undefined }),
    [status, search],
  );

  const showPrices = can("activities.setRate") || can("money.read");

  const columns: Column<Activity>[] = useMemo(() => {
    const cols: Column<Activity>[] = [
      {
        key: "name",
        header: "Actividad",
        render: (a) => (
          <Stack>
            <Typography sx={{ fontWeight: 600 }}>{a.name}</Typography>
            <Typography variant="caption" color="text.secondary">
              {titleCase(a.category)}
            </Typography>
          </Stack>
        ),
      },
      {
        key: "payMode",
        header: "Forma de pago",
        render: (a) => (
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip size="small" variant="outlined" label={PAY_MODE_LABEL[a.payMode]} />
            {a.workUnit && <Chip size="small" label={a.workUnit} />}
            {a.timeUnit && <Chip size="small" label={a.timeUnit} />}
          </Stack>
        ),
      },
    ];
    if (showPrices) {
      cols.push({
        key: "rate",
        header: "Precio vigente",
        align: "right",
        render: (a) =>
          a.rateSource === "weekly_price" ? (
            // Not a price of the activity at all: it comes from the week, and
            // it is frozen at settlement. Saying "$800" here would be a lie
            // with a number in it. Now it also says where the price DOES live,
            // which is the question somebody reading this cell is asking.
            /* Se llamaba «precio de la semana», que era el TERCER nombre del
               mismo estado: el papel lo llama PROVISIONAL y el tablero lo
               llamaba «estimado». Uno solo, y gana el que ya está impreso.
               El precio de la semana sigue existiendo —es lo que el dueño fija
               los lunes— pero es el nombre del precio, no el del estado. */
            <Tooltip title={`${PROVISIONAL_WHY} Lo pone el precio del kilo de la semana, que se cambia en «Precio del kilo».`}>
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                label={PROVISIONAL}
                sx={{ cursor: "help" }}
              />
            </Tooltip>
          ) : a.defaultRateCents === undefined ? (
            "—"
          ) : (
            <Stack alignItems="flex-end">
              <Money cents={a.defaultRateCents} />
              {a.rates && a.rates.length > 1 && (
                <Typography variant="caption" color="text.secondary">
                  {a.rates.length} precios con vigencia
                </Typography>
              )}
            </Stack>
          ),
      });
    }
    return cols;
  }, [showPrices]);

  if (denied) return <PermissionDenied moduleName="ver las actividades" />;

  return (
    <Box>
      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      <ModuleList<Activity>
        title="Actividades"
        singular="actividad"
        plural="actividades"
        rows={data}
        error={error}
        columns={columns}
        getId={(a) => a.id}
        getName={(a) => a.name}
        isInactive={(a) => a.status === "inactive"}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar actividad"
        statusFilter={status}
        onStatusFilterChange={setStatus}
        onCreate={can("activities.write") ? () => setEditing(null) : undefined}
        createLabel="Nueva actividad"
        onEdit={can("activities.write") ? (a) => setEditing(a) : undefined}
        onDeactivate={
          can("activities.setRate")
            ? async (a) => {
                try {
                  await api.deactivateActivity(a.id);
                  reload();
                } catch (e) {
                  setActionError(messageFor(e));
                }
              }
            : undefined
        }
        onReactivate={
          can("activities.setRate")
            ? async (a) => {
                await api.reactivateActivity(a.id);
                reload();
              }
            : undefined
        }
        emptyTitle="Todavía no hay actividades"
        emptyBody="Una actividad es un tipo de trabajo con su forma de pago: recolección por kilos, guadañada por jornal, siembra por contrato."
        onRowClick={can("activities.write") ? (a) => setEditing(a) : undefined}
        footer={
          <>
            El precio de una actividad tiene <strong>historial por fechas</strong>: al
            cambiarlo se agrega una vigencia nueva y las labores anteriores conservan el
            precio que estaba vigente en su fecha.
            {/* El letrero que faltaba: aquí es donde la gente venía a buscar el
                kilo de la semana, y se iba habiendo cambiado otra cosa. */}
            <Box sx={{ mt: 0.5 }}>
              El <strong>precio del kilo de la semana</strong> no se pone aquí: se pone
              semana por semana en{" "}
              <Link component={RouterLink} to="/precio-semana" sx={{ fontWeight: 700 }}>
                Precio del kilo
              </Link>
              .
            </Box>
          </>
        }
      />

      <ActivityFormDialog
        open={editing !== undefined}
        activity={editing ?? null}
        canSetRate={can("activities.setRate")}
        knownCategories={[...new Set((data ?? []).map((a) => a.category))]}
        onClose={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          reload();
        }}
      />
    </Box>
  );
}
