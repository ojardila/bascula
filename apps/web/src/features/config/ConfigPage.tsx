import { Link as RouterLink } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, Chip, Grid, Stack, Typography,
} from "@mui/material";
import PeopleIcon from "@mui/icons-material/People";
import { useAuth } from "../../auth/AuthContext";
import { PermissionDenied } from "../../components/Guards";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";

/** In Spanish, because this is a label somebody reads and not an enum. */
const FARM_STATUS: Record<"active" | "suspended", string> = {
  active: "Activa",
  suspended: "Suspendida",
};

/**
 * Read-only for now. The sprint cut keeps CONFIGURACIÓN to "farm data, prices
 * and users", and prices already live on the activities screen where they are
 * actually used. What is here is the farm card and an honest list of what the
 * next sprint fills in — an empty settings screen with five dead links is
 * worse than one that says what it is waiting for.
 */
export function ConfigPage() {
  const { user, can } = useAuth();

  /**
   * ── DE DÓNDE SALE «ESTADO» ──────────────────────────────────────────
   *
   * NOT from the session. `/v1/me` reports no farm lifecycle at all, so
   * `toMeUser` infers "active" from the fact that somebody is holding a live
   * token — a fair inference for deciding read-only, and not a fact to print.
   * This screen printed it anyway, in English, as though the server had said
   * so: "Estado: active".
   *
   * `GET /v1/farm` has the real column, `suspendedAt`. Until it answers there
   * is no state to show, and "—" says that rather than guessing.
   */
  const { data: farmDetail, error: farmError } = useAsync(() => api.getFarm(), []);

  // The permission check comes after the hooks, not before: an early return
  // above a `useAsync` changes the hook order between renders.
  if (!can("config.farm")) return <PermissionDenied moduleName="ver la configuración" />;

  const farm = farmDetail ?? user?.farm;
  const status = farmDetail?.status ?? null;

  return (
    <Box>
      <Typography variant="h1" gutterBottom>
        Configuración
      </Typography>

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Card>
            <CardContent>
              <Typography variant="h3" gutterBottom>
                Datos de la finca
              </Typography>
              <Stack spacing={1.5} sx={{ mt: 2 }}>
                {[
                  ["Nombre", farm?.name],
                  ["Zona horaria", farm?.timezone],
                  ["Moneda", farm?.currency],
                ].map(([k, v]) => (
                  <Stack key={k} direction="row" justifyContent="space-between">
                    <Typography color="text.secondary">{k}</Typography>
                    <Typography sx={{ fontWeight: 600 }}>{v}</Typography>
                  </Stack>
                ))}
                <Stack direction="row" justifyContent="space-between">
                  <Typography color="text.secondary">Estado</Typography>
                  {status === null ? (
                    <Typography
                      sx={{ color: "text.disabled", fontWeight: 600 }}
                      title={
                        farmError
                          ? "No se pudo consultar el estado de la finca."
                          : "Consultando el estado de la finca…"
                      }
                    >
                      —
                    </Typography>
                  ) : (
                    <Chip
                      size="small"
                      label={FARM_STATUS[status]}
                      color={status === "suspended" ? "error" : "success"}
                      variant="outlined"
                    />
                  )}
                </Stack>
              </Stack>
              <Alert severity="info" sx={{ mt: 2 }}>
                La zona horaria de la finca decide a qué día pertenece cada labor y a qué
                semana cada precio. Cambiarla mueve cifras ya registradas, así que se
                edita con la API real, no aquí.
              </Alert>
            </CardContent>
          </Card>
        </Grid>

        {/* Gestión de usuarios. Owner only — sistema.md §3.3 leaves the
            administrator's column blank for this one — so the card is not even
            shown to an administrator, who would only meet PermissionDenied. */}
        {can("config.users") && (
          <Grid size={{ xs: 12, md: 6 }}>
            <Card>
              <CardContent>
                <Typography variant="h3" gutterBottom>
                  Usuarios de la finca
                </Typography>
                <Typography color="text.secondary" sx={{ mb: 2 }}>
                  Invite a un administrador o a un pesador y decida qué puede ver cada
                  uno. Hasta ahora, la única forma de crear un usuario era registrar una
                  finca nueva.
                </Typography>
                <Button
                  component={RouterLink}
                  to="/configuracion/usuarios"
                  variant="outlined"
                  startIcon={<PeopleIcon />}
                >
                  Gestionar usuarios
                </Button>
              </CardContent>
            </Card>
          </Grid>
        )}

        <Grid size={{ xs: 12, md: 6 }}>
          <Card>
            <CardContent>
              <Typography variant="h3" gutterBottom>
                Lo que llega después
              </Typography>
              <Stack spacing={1.5} sx={{ mt: 2 }}>
                {[
                  ["Precios de trabajo con historial", "en Actividades"],
                  ["Dispositivos y sesiones", "más adelante"],
                  ["Bitácora de auditoría", "más adelante"],
                ].map(([k, v]) => (
                  <Stack key={k} direction="row" justifyContent="space-between" alignItems="center">
                    <Typography color="text.secondary">{k}</Typography>
                    <Chip size="small" label={v} />
                  </Stack>
                ))}
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
