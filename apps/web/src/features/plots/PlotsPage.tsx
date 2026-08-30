import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Box, Chip, Stack, Tooltip, Typography } from "@mui/material";
import { ModuleList, type Column, type StatusFilter } from "../../components/ModuleList";
import { PermissionDenied } from "../../components/Guards";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { formatArea } from "../../lib/money";
import { LOTE } from "../../lib/vocab";
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
                inactivo
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
            <span>{p.areaHa === null ? "—" : `${formatArea(p.areaHa)} ha`}</span>
            {/* Declared and computed always disagree. Showing only one is
                deciding for the owner which of them lies, so both are here. */}
            {p.computedAreaHa === null ? (
              <Typography variant="caption" color="text.disabled">
                sin polígono
              </Typography>
            ) : (
              <Tooltip
                title={`Declarada ${p.areaHa === null ? "sin declarar" : `${formatArea(p.areaHa)} ha`} · calculada del polígono ${formatArea(p.computedAreaHa)} ha`}
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

  if (denied) return <PermissionDenied moduleName="ver los lotes" />;

  /**
   * A SUM THAT KNOWS WHAT IS MISSING. Lots with no declared area are counted
   * separately instead of contributing a zero: "18,40 ha declaradas" over a
   * list where two lots never declared one is a smaller farm than the one that
   * exists, and nothing on the line said so.
   */
  const declared = (data ?? []).filter((p) => p.areaHa !== null);
  const totalHa = declared.reduce((a, p) => a + (p.areaHa as number), 0);
  const undeclared = (data ?? []).length - declared.length;

  return (
    <Box>
      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      <ModuleList<Plot>
        title={LOTE.Many}
        singular={LOTE.one}
        plural={LOTE.many}
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
        onCreate={can("plots.write") ? () => navigate(`${LOTE.path}/nuevo`) : undefined}
        createLabel={`Nuevo ${LOTE.one}`}
        onRowClick={(p) => navigate(`${LOTE.path}/${p.id}`)}
        onEdit={can("plots.write") ? (p) => navigate(`${LOTE.path}/${p.id}/editar`) : undefined}
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
        emptyTitle={`Todavía no hay ${LOTE.many}`}
        emptyBody="Un lote es un pedazo de tierra con su ubicación, su área y sus cultivos. Es lo primero que hay que crear: las labores se registran sobre él."
        footer={
          data
            ? `${data.length} ${data.length === 1 ? LOTE.one : LOTE.many} · ` +
              `${formatArea(totalHa)} ha declaradas` +
              (undeclared > 0
                ? ` · ${undeclared} sin superficie declarada, que no está en ese total`
                : "")
            : null
        }
      />
    </Box>
  );
}
