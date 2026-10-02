import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  Stack,
  Typography,
} from "@mui/material";
import { api, type McpActivity } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { useAsync } from "../../lib/useAsync";

/**
 * What each MCP write tool does, in the words the owner uses. The names are
 * the server's (handlers_mcp_write.go); an unknown one shows as it is.
 */
export const TOOL_LABELS: Record<string, string> = {
  create_worker: "Creó un trabajador",
  update_worker: "Actualizó un trabajador",
  create_plot: "Creó un lote",
  register_weighing: "Registró una pesada",
  register_harvest_week: "Registró la cosecha de una semana",
  correct_weighing: "Corrigió una pesada",
  void_weighing: "Anuló una pesada",
  set_kilo_price: "Cambió el precio del kilo",
  register_advance: "Registró un anticipo",
  register_payment: "Registró un pago",
  create_settlement: "Liquidó a un trabajador",
  void_settlement: "Anuló una liquidación",
};

const OUTCOME: Record<
  McpActivity["outcome"],
  { label: string; color: "success" | "warning" | "error" }
> = {
  done: { label: "Hecho", color: "success" },
  refused: { label: "No permitido", color: "warning" },
  failed: { label: "Falló", color: "error" },
};

function when(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleString("es-CO", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    });
  } catch {
    return new Date(iso).toLocaleString("es-CO");
  }
}

/**
 * «Lo que hicieron los asistentes»: every write an assistant made on the farm
 * through the MCP tools, or tried to make and was refused, with who and
 * through which assistant. Owner and administrator only (the server refuses
 * the weigher). The summary is text the server wrote; it is shown as text.
 */
export function McpActivityCard() {
  const { user, can } = useAuth();
  const allowed = can("mcp.activity");
  const tz = user?.farm?.timezone ?? "America/Bogota";
  const { data, error } = useAsync(
    () => (allowed ? api.listMcpActivity() : Promise.resolve({ items: [] })),
    [allowed],
  );
  if (!allowed) return null;
  const items = data?.items ?? [];

  return (
    <Card>
      <CardContent sx={{ p: { xs: 2.5, sm: 3 } }}>
        <Typography variant="h3" gutterBottom>
          Lo que hicieron los asistentes
        </Typography>
        <Typography sx={{ color: "text.secondary", mb: 2, fontSize: "1rem" }}>
          Cada cosa que un asistente registró o intentó registrar en la finca:
          quién, con qué asistente y cuándo.
        </Typography>
        {error && (
          <Alert severity="warning">
            No pudimos cargar esta lista. Intente más tarde.
          </Alert>
        )}
        {!error && data && items.length === 0 && (
          <Typography sx={{ fontSize: "1.05rem" }}>
            Todavía ningún asistente ha registrado nada.
          </Typography>
        )}
        <Stack
          spacing={1.5}
          component="ul"
          sx={{ listStyle: "none", p: 0, m: 0 }}
          aria-label="Actividad de los asistentes"
        >
          {items.map((a) => (
            <Box
              component="li"
              key={a.id}
              sx={{
                border: 1,
                borderColor: "divider",
                borderRadius: 2,
                p: 1.5,
              }}
            >
              <Stack
                direction="row"
                spacing={1}
                sx={{
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <Typography sx={{ fontWeight: 700, fontSize: "1.05rem" }}>
                  {TOOL_LABELS[a.tool] ?? a.tool}
                </Typography>
                <Chip
                  size="small"
                  variant="outlined"
                  label={OUTCOME[a.outcome]?.label ?? a.outcome}
                  color={OUTCOME[a.outcome]?.color ?? "default"}
                />
              </Stack>
              <Typography sx={{ color: "text.secondary", fontSize: "0.95rem" }}>
                {when(a.createdAt, tz)} · {a.userName || "Usuario"} ·{" "}
                {a.clientName || "Asistente"}
              </Typography>
              {a.summary && (
                <Typography
                  sx={{ fontSize: "0.95rem", mt: 0.5, wordBreak: "break-word" }}
                >
                  {a.summary}
                </Typography>
              )}
            </Box>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}
