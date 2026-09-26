/**
 * `/olvide-mi-clave`. There is no self-service password reset yet (the
 * platform cannot send email), so this page says plainly who can help: the
 * farm's owner or administrator changes the password in Configuración →
 * Usuarios.
 */
import { Link as RouterLink } from "react-router-dom";
import { Button, Stack, Typography } from "@mui/material";
import { AuthLayout } from "./AuthLayout";

export function ForgotPasswordPage() {
  return (
    <AuthLayout title="¿Olvidó su clave o su usuario?">
      <Stack spacing={2.5}>
        <Typography sx={{ fontSize: "1.15rem" }}>
          Su usuario es el correo con el que entra a la finca.
        </Typography>
        <Typography sx={{ fontSize: "1.15rem" }}>
          Si no recuerda la clave o el correo, pídale al <strong>dueño</strong> o al{" "}
          <strong>administrador</strong> de la finca que se la cambie. Ellos lo hacen
          en <strong>Configuración → Usuarios</strong>.
        </Typography>
        <Typography sx={{ fontSize: "1.15rem" }}>
          Después entre con la clave nueva que le den.
        </Typography>
        <Button
          component={RouterLink}
          to="/entrar"
          variant="contained"
          size="large"
          sx={{ minHeight: 56, fontSize: "1.15rem" }}
        >
          Volver a entrar
        </Button>
      </Stack>
    </AuthLayout>
  );
}
