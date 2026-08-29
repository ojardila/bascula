import { Link as RouterLink } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, Chip, Grid, Stack, Typography,
} from "@mui/material";
import PeopleIcon from "@mui/icons-material/People";
import { useAuth } from "../../auth/AuthContext";
import { PermissionDenied } from "../../components/Guards";

/**
 * Read-only for now. The sprint cut keeps CONFIGURACIÓN to "farm data, prices
 * and users", and prices already live on the activities screen where they are
 * actually used. What is here is the farm card and an honest list of what the
 * next sprint fills in — an empty settings screen with five dead links is
 * worse than one that says what it is waiting for.
 */
export function ConfigPage() {
  const { user, can } = useAuth();
  if (!can("config.farm")) return <PermissionDenied moduleName="ver la configuración" />;

  const farm = user?.farm;

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
                  <Chip
                    size="small"
                    label={
                      farm?.status === "trial"
                        ? `En prueba · ${farm.trialDaysLeft} días`
                        : farm?.status
                    }
                    color={farm?.status === "suspended" ? "error" : "warning"}
                    variant="outlined"
                  />
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
