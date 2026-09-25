/**
 * Two ways to weigh: everyone on the lote (masiva) or one person at a time.
 */
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import { Box, Button, Tab, Tabs, Typography, useMediaQuery, useTheme } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { PermissionDenied } from "../../components/Guards";
import { useAuth } from "../../auth/AuthContext";
import { PlanillaPage } from "./PlanillaPage";
import { WeighingForm } from "./WeighingForm";

export { pickHarvestActivity } from "./planilla";

export function RecoleccionFormPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  // On a phone the one-person form comes first: the crew grid needs a wide
  // screen. A link that names the tab still wins.
  const phone = useMediaQuery(useTheme().breakpoints.down("sm"));
  const asked = params.get("quien");
  const quien = asked === "uno" || (asked !== "todos" && phone) ? "uno" : "todos";

  if (!can("workRecords.write")) {
    return <PermissionDenied moduleName="registrar recolección" />;
  }

  return (
    <Box>
      <Button
        component={RouterLink}
        to="/cosecha"
        startIcon={<ArrowBackIcon />}
        size="small"
        sx={{ mb: 2 }}
      >
        Volver a la cosecha
      </Button>
      <Typography variant="h1" gutterBottom>
        Registrar recolección
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Una persona: una pesada y sigue. Masiva: todos los de un lote, un día.
      </Typography>
      <Tabs
        value={quien}
        onChange={(_, v: "todos" | "uno") => {
          setParams((prev) => {
            const n = new URLSearchParams(prev);
            n.set("quien", v);
            return n;
          });
        }}
        variant="fullWidth"
        sx={{ mb: 2, maxWidth: 560, "& .MuiTab-root": { fontSize: "1.1rem", minHeight: 56 } }}
      >
        <Tab value="uno" label="Una persona" />
        <Tab value="todos" label="Masiva" />
      </Tabs>
      {quien === "uno" ? <WeighingForm /> : <PlanillaPage lockedMode="dia" hideChrome />}
    </Box>
  );
}
