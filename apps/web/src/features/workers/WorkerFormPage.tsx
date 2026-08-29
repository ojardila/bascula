import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, Grid, MenuItem, Stack, TextField, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { PhotoField } from "./PhotoField";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { uuidv7 } from "../../lib/uuid";
import type { DocumentType } from "../../api/types";

const DOC_TYPES: Array<{ value: DocumentType; label: string }> = [
  { value: "CC", label: "Cédula de ciudadanía" },
  { value: "CE", label: "Cédula de extranjería" },
  { value: "TI", label: "Tarjeta de identidad" },
  { value: "PPT", label: "Permiso por protección temporal" },
  { value: "PAS", label: "Pasaporte" },
];

export function WorkerFormPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const editing = Boolean(id);

  const [workerId] = useState(() => id ?? uuidv7());
  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [documentType, setDocumentType] = useState<DocumentType>("CC");
  const [documentNumber, setDocumentNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("Colombia");
  const [startedAt, setStartedAt] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    api
      .getWorker(id)
      .then((w) => {
        setName(w.name);
        setLastName(w.lastName);
        setDocumentType(w.documentType);
        setDocumentNumber(w.documentNumber);
        setPhone(w.phone ?? "");
        setAddress(w.address ?? "");
        setCity(w.city ?? "");
        setCountry(w.country ?? "Colombia");
        setStartedAt(w.startedAt ?? "");
        setPhoto(w.photoUrl);
      })
      .catch((e) => setError(messageFor(e)));
  }, [id]);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Escriba el nombre.";
    if (!lastName.trim()) e.lastName = "Escriba los apellidos.";
    if (!documentNumber.trim()) e.documentNumber = "Escriba el número de identificación.";
    // Not a format rule: cédulas, cédulas de extranjería and PPTs do not share
    // one. Only that something is there and that it is not obviously a name.
    if (!phone.trim()) e.phone = "Escriba un teléfono de contacto.";
    else if (!/^[\d\s+()-]{7,30}$/.test(phone.trim())) {
      e.phone = "Escriba solo números, con o sin indicativo.";
    }
    setFields(e);
    return Object.keys(e).length === 0;
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const body = {
        id: workerId,
        name: name.trim(),
        lastName: lastName.trim(),
        documentType,
        documentNumber: documentNumber.trim(),
        phone: phone.trim(),
        address: address.trim(),
        city: city.trim(),
        country,
        photoDataUrl: photo,
        startedAt: startedAt || undefined,
      };
      const saved = editing
        ? await api.updateWorker(workerId, body)
        : await api.createWorker(body);
      navigate(`/empleados/${saved.id}`, { replace: true });
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) setFields(e.fieldErrors);
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box component="form" onSubmit={onSubmit} noValidate>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate("/empleados")}
        color="inherit"
        sx={{ mb: 1 }}
      >
        Empleados
      </Button>
      <Typography variant="h1" gutterBottom>
        {editing ? "Modificar empleado" : "Nuevo empleado"}
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Card>
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                Datos del empleado
              </Typography>
              <Stack spacing={2.5} sx={{ mt: 2 }}>
                <PhotoField
                  value={photo}
                  onChange={setPhoto}
                  fallback={(name[0] ?? "?").toUpperCase()}
                />
                <Grid container spacing={2}>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      label="Nombres"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      error={!!fields.name}
                      helperText={fields.name}
                      size="medium"
                      fullWidth
                      required
                      autoFocus
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      label="Apellidos"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      error={!!fields.lastName}
                      helperText={fields.lastName}
                      size="medium"
                      fullWidth
                      required
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      select
                      label="Tipo de identificación"
                      value={documentType}
                      onChange={(e) => setDocumentType(e.target.value as DocumentType)}
                      size="medium"
                      fullWidth
                      required
                    >
                      {DOC_TYPES.map((d) => (
                        <MenuItem key={d.value} value={d.value}>
                          {d.label}
                        </MenuItem>
                      ))}
                    </TextField>
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      label="Número de identificación"
                      value={documentNumber}
                      onChange={(e) => setDocumentNumber(e.target.value)}
                      error={!!fields.documentNumber}
                      helperText={fields.documentNumber}
                      size="medium"
                      fullWidth
                      required
                    />
                  </Grid>
                </Grid>
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, md: 5 }}>
          <Card>
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                Datos de contacto
              </Typography>
              <Stack spacing={2.5} sx={{ mt: 2 }}>
                <TextField
                  label="Teléfono"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  error={!!fields.phone}
                  helperText={fields.phone}
                  size="medium"
                  fullWidth
                  required
                  inputMode="tel"
                />
                <TextField
                  label="Dirección"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  size="medium"
                  fullWidth
                />
                <Grid container spacing={2}>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      label="Ciudad o municipio"
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      size="medium"
                      fullWidth
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      label="País"
                      value={country}
                      onChange={(e) => setCountry(e.target.value)}
                      size="medium"
                      fullWidth
                    />
                  </Grid>
                </Grid>
                <TextField
                  label="Trabaja desde"
                  type="date"
                  value={startedAt}
                  onChange={(e) => setStartedAt(e.target.value)}
                  size="medium"
                  fullWidth
                  slotProps={{ inputLabel: { shrink: true } }}
                />
              </Stack>
            </CardContent>
          </Card>

          {/* RSP-004 also asks for a cross-farm background check before saving.
              That is the registry service, and `docs/decisiones.md` keeps it
              out of this sprint — deliberately, not by omission. Saying so
              here is cheaper than the owner wondering where it went. */}
          <Alert severity="info" sx={{ mt: 2 }}>
            La consulta del historial en otras fincas (RSP-009) no entra en este
            sprint: es un servicio aparte con reglas de habeas data propias. El alta
            del empleado nunca dependerá de esa consulta.
          </Alert>
        </Grid>
      </Grid>

      <Stack direction="row" spacing={2} sx={{ mt: 3 }} justifyContent="flex-end">
        <Button color="inherit" onClick={() => navigate("/empleados")}>
          Cancelar
        </Button>
        <Button type="submit" variant="contained" disabled={busy}>
          {busy ? "Guardando…" : "Guardar empleado"}
        </Button>
      </Stack>
    </Box>
  );
}
