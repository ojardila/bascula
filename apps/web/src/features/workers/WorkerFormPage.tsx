import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, AlertTitle, Box, Button, Card, CardContent, Grid, MenuItem, Stack, TextField,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { PhotoField } from "./PhotoField";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { uuidv7 } from "../../lib/uuid";
import { useWriteOnce } from "../../lib/writeOnce";
import type { DocumentType } from "../../api/types";
import { DateField } from "../../components/DateField";

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
  /**
   * This form was ALREADY half-safe: `workerId` is minted once with
   * `useState(() => id ?? uuidv7())`, so a double click posts the same id
   * twice and the server answers the second one with the row it already has.
   * That is the half that protects the data. `useWriteOnce` adds the other
   * half — the request that never leaves — and, being the same primitive
   * every other write on this app now uses, it keeps one answer to the
   * question instead of two.
   */
  const { busy, run: runOnce } = useWriteOnce();
  /**
   * The same document already belongs to somebody who is DEACTIVATED.
   *
   * Not an error to display and walk away from. `ux_employees_doc` is partial
   * on `deleted_at IS NULL`, so nothing in the database stops a second file
   * for one person — from then on the handset writes to one and the web to the
   * other, the balance is split in two, and nothing says so.
   * `docs/sincronizacion.md` lists it as the one conflict with no automatic
   * repair. So the screen offers the repair: reactivate the person who is
   * already here.
   *
   * Leaving somebody stuck at a red box is how the duplicate gets created
   * anyway, under a document number with a dot moved.
   */
  const [existingDeleted, setExistingDeleted] = useState<{ id: string; name: string } | null>(null);

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
    const outcome = await runOnce(`empleado|${workerId}|${documentNumber.trim()}`, async () => {
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
      return editing ? api.updateWorker(workerId, body) : api.createWorker(body);
    }).catch(async (e: unknown) => {
      if (e instanceof ApiError && e.code === "EMPLOYEE_EXISTS_DELETED") {
        const existingId = String(e.details.employeeId ?? "");
        // Fetch the name so the offer says WHO, not "the existing worker". A
        // person deciding whether to reactivate needs to recognise them.
        const who = existingId ? await api.getWorker(existingId).catch(() => null) : null;
        setExistingDeleted({
          id: existingId,
          name: who ? `${who.name} ${who.lastName}`.trim() : "",
        });
      } else {
        if (e instanceof ApiError && Object.keys(e.fieldErrors).length) setFields(e.fieldErrors);
        setError(messageFor(e));
      }
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    navigate(`/empleados/${outcome.value.id}`, { replace: true });
  }

  async function reactivate() {
    if (!existingDeleted?.id) return;
    const who = existingDeleted.id;
    const outcome = await runOnce(`reactivar|${who}`, () => api.reactivateWorker(who)).catch(
      (e: unknown) => {
        setError(messageFor(e));
        setExistingDeleted(null);
        return { ran: false } as const;
      },
    );
    if (!outcome.ran) return;
    navigate(`/empleados/${who}`, { replace: true });
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

      {existingDeleted && (
        <Alert
          severity="warning"
          sx={{ mb: 2 }}
          action={
            <Stack direction="row" spacing={1}>
              <Button
                color="inherit"
                size="small"
                onClick={() => navigate(`/empleados/${existingDeleted.id}`)}
              >
                Ver la ficha
              </Button>
              <Button variant="contained" size="small" disabled={busy} onClick={reactivate}>
                Reactivar
              </Button>
            </Stack>
          }
        >
          <AlertTitle>Esa identificación ya existe en la finca</AlertTitle>
          {existingDeleted.name
            ? `${existingDeleted.name} tiene ese documento y está inactivo.`
            : "Un empleado con ese documento ya está registrado y está inactivo."}{" "}
          Reactívelo en vez de crear uno nuevo: si crea otro, la misma persona queda con dos
          cuentas, el saldo se parte en dos y nada avisa de ello.
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
                <DateField label="Trabaja desde" value={startedAt} onChange={setStartedAt} />
              </Stack>
            </CardContent>
          </Card>

          {/* RSP-004 also asks for a cross-farm background check before saving.
              That is the registry service, and `docs/decisiones.md` keeps it
              out of this sprint — deliberately, not by omission.
              ── Y ESO NO ES ASUNTO DE QUIEN LLENA ESTA FICHA ─────────────
              Aquí había un recuadro que decía «la consulta del historial en
              otras fincas (RSP-009) no entra en este sprint: es un servicio
              aparte con reglas de habeas data propias». Tres cosas que sólo
              significan algo dentro del equipo —un código de ticket, la
              palabra sprint y un término jurídico— en el formulario con el
              que se contrata a un recolector. Quien lo lee no aprende nada
              que pueda usar; aprende que la pantalla no está escrita para
              él. La decisión sigue documentada donde se toman las
              decisiones, que es este comentario y `docs/decisiones.md`. */}
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
