/**
 * «REGISTRAR UNA RECOLECCIÓN»: one person, one weighing.
 *
 * The phone-first form next to the scale (`WeighingForm`), which keeps
 * working with no signal. The crew-wide sheet is «Registrar la semana»
 * (`/cosecha/registrar-semana`); an old link that asked for the crew on
 * one day (`?quien=todos`) goes to the day planilla it used to show.
 */
import { Link as RouterLink, Navigate, useSearchParams } from "react-router-dom";
import { Box, Button, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { PermissionDenied } from "../../components/Guards";
import { useAuth } from "../../auth/AuthContext";
import { WeighingForm } from "./WeighingForm";

export { pickHarvestActivity } from "./planilla";

export function RecoleccionFormPage() {
  const { can } = useAuth();
  const [params] = useSearchParams();

  if (!can("workRecords.write")) {
    return <PermissionDenied moduleName="registrar recolección" />;
  }

  if (params.get("quien") === "todos") {
    const next = new URLSearchParams(params);
    next.delete("quien");
    next.set("modo", "dia");
    return <Navigate to={`/labores/planilla?${next.toString()}`} replace />;
  }

  return (
    <Box>
      {can("harvest.read") && (
        <Button component={RouterLink} to="/cosecha" startIcon={<ArrowBackIcon />} sx={{ mb: 1, fontSize: "1rem" }}>
          Volver a la cosecha
        </Button>
      )}
      <Typography variant="h1" gutterBottom>
        Registrar una recolección
      </Typography>
      <Typography sx={{ mb: 2, fontSize: "1.1rem" }} color="text.secondary">
        Una persona, una pesada. Funciona también sin señal.
      </Typography>
      <WeighingForm />
    </Box>
  );
}
