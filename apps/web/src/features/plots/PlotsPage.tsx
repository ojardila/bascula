import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Box, Chip, Stack, Tooltip, Typography } from "@mui/material";
import { ModuleList, type Column, type StatusFilter } from "../../components/ModuleList";
import { PermissionDenied } from "../../components/Guards";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { formatArea } from "../../lib/money";
import type { Plot } from "../../api/types";

export function PlotsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, error, denied, reload } = useAsync(
    () => api.listPlots({ status, q: search || undefined }),
    [status, search],
  );

  const columns: Column<Plot>[] = useMemo(
    () => [
      {
        key: "name",
        header: "Nombre",
        render: (p) => (
          <Stack>
            <Typography sx={{ fontWeight: 600 }}>{p.name}</Typography>
            {p.status === "inactive" && (
              <Typography variant="caption" color="text.secondary">
                inactiva
              </Typography>
            )}
          </Stack>
        ),
      },
      {
        key: "location",
        header: "Ubicación",
        render: (p) => `${p.department} · ${p.municipality}`,
        secondary: true,
      },
      {
        key: "area",
        header: "Área",
        align: "right",
        render: (p) => (
          <Stack alignItems="flex-end">
            <span>{formatArea(p.areaHa)} ha</span>
            {/* Declared and computed always disagree. Showing only one is
                deciding for the owner which of them lies, so both are here. */}
            {p.computedAreaHa === null ? (
              <Typography variant="caption" color="text.disabled">
                sin polígono
              </Typography>
            ) : (
              <Tooltip
                title={`Declarada ${formatArea(p.areaHa)} ha · calculada del polígono ${formatArea(p.computedAreaHa)} ha`}
              >
                {/* No warning icon and no amber. The two figures differing is
                    the normal state of the world, not an incident: a deed says
                    one thing and a hillside traced with a mouse says another.
                    A yellow triangle on every row with a polygon teaches
                    people to ignore yellow triangles. */}
                <Typography variant="caption" color="text.secondary">
                  calculada {formatArea(p.computedAreaHa)} ha
                </Typography>
              </Tooltip>
            )}
          </Stack>
        ),
      },
      {
        key: "crops",
        header: "Cultivos",
        render: (p) => (
          <Stack direction="row" gap={0.5} flexWrap="wrap">
            {p.crops.length === 0 && (
              <Typography variant="caption" color="text.secondary">
                sin cultivos
              </Typography>
            )}
            {p.crops.map((c) => (
              <Chip
                key={c.id}
                size="small"
                variant="outlined"
                label={[c.cropTypeName, c.varietyName].filter(Boolean).join(" ")}
              />
            ))}
          </Stack>
        ),
      },
    ],
    [],
  );

  if (denied) return <PermissionDenied moduleName="ver las parcelas" />;

  const totalHa = (data ?? []).reduce((a, p) => a + p.areaHa, 0);

  return (
    <Box>
      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      <ModuleList<Plot>
        title="Parcelas"
        singular="parcela"
        plural="parcelas"
        rows={data}
        error={error}
        columns={columns}
        getId={(p) => p.id}
        getName={(p) => p.name}
        isInactive={(p) => p.status === "inactive"}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por nombre o municipio"
        statusFilter={status}
        onStatusFilterChange={setStatus}
        onCreate={can("plots.write") ? () => navigate("/parcelas/nueva") : undefined}
        createLabel="Nueva parcela"
        onRowClick={(p) => navigate(`/parcelas/${p.id}`)}
        onEdit={can("plots.write") ? (p) => navigate(`/parcelas/${p.id}/editar`) : undefined}
        onDeactivate={
          can("plots.delete")
            ? async (p) => {
                try {
                  await api.deactivatePlot(p.id);
                  reload();
                } catch (e) {
                  setActionError(String((e as Error).message));
                }
              }
            : undefined
        }
        onReactivate={
          can("plots.delete")
            ? async (p) => {
                await api.reactivatePlot(p.id);
                reload();
              }
            : undefined
        }
        emptyTitle="Todavía no hay parcelas"
        emptyBody="Una parcela es un lote con su ubicación, su área y sus cultivos. Es lo primero que hay que crear: las labores se registran sobre ella."
        footer={
          data
            ? `${data.length} ${data.length === 1 ? "parcela" : "parcelas"} · ${formatArea(totalHa)} ha declaradas`
            : null
        }
      />
    </Box>
  );
}
