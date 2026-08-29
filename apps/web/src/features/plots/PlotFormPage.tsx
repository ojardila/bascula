/**
 * RSP-001 / RSP-002, in the two steps of cropti: identity and location first,
 * crops second.
 *
 * Two decisions worth knowing about:
 *
 * - **Step 2 starts with a Café row already there.** RSP-001's exception says
 *   the system offers a coffee crop by default. That is done by seeding the
 *   catalogue and pre-filling a row, not with a special case in the code — so
 *   a farm that grows avocado deletes one row instead of fighting a hardcoded
 *   assumption.
 *
 * - **The "add if it does not exist" of the autocompletes is a POST that is
 *   idempotent by lower(name).** Typing "café" when "Café" exists returns the
 *   existing row, so the catalogue cannot accumulate the same crop five times
 *   with five capitalisations. That guarantee is the server's; the UI just has
 *   to not work around it.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Autocomplete, Box, Button, Card, CardContent, Grid, IconButton,
  MenuItem, Stack, Step, StepLabel, Stepper, TextField, Typography, createFilterOptions,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AddIcon from "@mui/icons-material/Add";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { PlotBoundaryEditor, type MapNeighbour } from "./PlotBoundaryEditor";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { uuidv7 } from "../../lib/uuid";
import { useWriteOnce } from "../../lib/writeOnce";
import { areaHaOfRing, asGeometry, openRing, outerRings, type PolygonGeometry } from "../../lib/geo";
import { formatArea } from "../../lib/money";
import type { CatalogItem, PlotInput } from "../../api/types";

const DEPARTMENTS = [
  "Caldas", "Quindío", "Risaralda", "Antioquia", "Huila", "Tolima",
  "Nariño", "Cauca", "Santander", "Norte de Santander", "Cundinamarca",
  "Valle del Cauca", "Cesar", "Magdalena", "Boyacá", "Otro",
];

interface CropRow {
  key: string;
  id: string;
  cropType: CatalogItem | null;
  variety: CatalogItem | null;
  areaHa: string;
  plantedAt: string;
}

const filter = createFilterOptions<CatalogItem>();

/** Option shown when what was typed is not in the catalogue yet. */
function withCreateOption(options: CatalogItem[], input: string): CatalogItem[] {
  const typed = input.trim();
  if (!typed) return options;
  const exists = options.some(
    (o) => o.name.toLocaleLowerCase("es") === typed.toLocaleLowerCase("es"),
  );
  return exists ? options : [...options, { id: "__new__", name: typed }];
}

export function PlotFormPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const editing = Boolean(id);

  const [step, setStep] = useState(0);
  const [plotId] = useState(() => id ?? uuidv7());
  const [name, setName] = useState("");
  const [areaHa, setAreaHa] = useState("");
  const [department, setDepartment] = useState("Caldas");
  const [municipality, setMunicipality] = useState("");
  const [cropTypes, setCropTypes] = useState<CatalogItem[]>([]);
  const [varieties, setVarieties] = useState<CatalogItem[]>([]);
  const [rows, setRows] = useState<CropRow[]>([]);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const { busy, run: runOnce } = useWriteOnce();
  /**
   * The polygon, held here rather than inside the map, because the form saves
   * it: `POST /v1/plots` and `PATCH /v1/plots/{id}` both accept a `boundary`
   * and store it in the same transaction as the name and the crops. One write
   * instead of two means a new lot cannot end up existing with its shape lost
   * to a second call that failed on its own.
   */
  const [boundary, setBoundary] = useState<PolygonGeometry | null>(null);
  /** Only so the map can draw the rest of the farm behind this lot. */
  const [neighbours, setNeighbours] = useState<MapNeighbour[]>([]);
  /** The map is mounted from the loaded shape, so it waits for the GET. */
  const [mapReady, setMapReady] = useState(!id);
  const [loadedBoundary, setLoadedBoundary] = useState<unknown>(null);

  useEffect(() => {
    Promise.all([api.cropTypes(), api.varieties()])
      .then(([t, v]) => {
        setCropTypes(t);
        setVarieties(v);
        setRows((current) =>
          current.length
            ? current
            : [
                {
                  key: uuidv7(),
                  id: uuidv7(),
                  // RSP-001's exception: a coffee row is already waiting.
                  cropType: t.find((x) => x.name === "Café") ?? null,
                  variety: null,
                  areaHa: "",
                  plantedAt: "",
                },
              ],
        );
      })
      .catch((e) => setError(messageFor(e)));
  }, []);

  useEffect(() => {
    if (!id) return;
    api
      .getPlot(id)
      .then((p) => {
        setName(p.name);
        setAreaHa(String(p.areaHa).replace(".", ","));
        setDepartment(p.department);
        setMunicipality(p.municipality);
        setLoadedBoundary(p.boundary);
        setBoundary(null);
        setMapReady(true);
        setRows(
          p.crops.map((c) => ({
            key: c.id,
            id: c.id,
            cropType: { id: c.cropTypeId, name: c.cropTypeName },
            variety: c.varietyId ? { id: c.varietyId, name: c.varietyName ?? "" } : null,
            areaHa: c.areaHa === null ? "" : String(c.areaHa).replace(".", ","),
            plantedAt: c.plantedAt ?? "",
          })),
        );
      })
      .catch((e) => {
        setMapReady(true);
        setError(messageFor(e));
      });
  }, [id]);

  // The other lots, for the map's context layer only. A failure here costs
  // nothing that matters, so it is swallowed rather than shown as an error on
  // a form about something else.
  useEffect(() => {
    api
      .listPlots({ status: "active" })
      .then((all) =>
        setNeighbours(
          all.flatMap((p) => {
            if (p.id === plotId) return [];
            const g = asGeometry(p.boundary);
            return g ? [{ id: p.id, name: p.name, boundary: g }] : [];
          }),
        ),
      )
      .catch(() => setNeighbours([]));
  }, [plotId]);

  /**
   * What the drawing measures right now — the browser's arithmetic, replaced
   * by the server's the moment the form is saved.
   */
  const drawnAreaHa = useMemo(() => {
    const g = boundary ?? asGeometry(loadedBoundary);
    if (!g) return null;
    const ring = openRing(outerRings(g)[0] ?? []);
    return ring.length >= 3 ? areaHaOfRing(ring) : null;
  }, [boundary, loadedBoundary]);

  const parsedArea = useMemo(() => {
    const n = Number(areaHa.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  }, [areaHa]);

  function validateStep1(): boolean {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Escriba el nombre del lote.";
    else if (name.trim().length > 80) e.name = "Máximo 80 caracteres.";
    if (!areaHa.trim()) e.areaHa = "Escriba la superficie en hectáreas.";
    else if (Number.isNaN(parsedArea)) e.areaHa = "Escriba un número, por ejemplo 4,20.";
    else if (parsedArea <= 0) e.areaHa = "La superficie tiene que ser mayor que cero.";
    if (!municipality.trim()) e.municipality = "Escriba el municipio.";
    setFields(e);
    return Object.keys(e).length === 0;
  }

  function validateStep2(): boolean {
    const e: Record<string, string> = {};
    const usable = rows.filter((r) => r.cropType);
    if (usable.length === 0) {
      e.crops = "Agregue al menos un cultivo con su tipo. Sin cultivo no se pueden registrar labores sobre esta parcela.";
    }
    setFields(e);
    return Object.keys(e).length === 0;
  }

  /** Resolve a typed-in catalogue entry to a real id before saving. */
  async function resolveCropType(item: CatalogItem): Promise<CatalogItem> {
    if (item.id !== "__new__") return item;
    const created = await api.createCropType(item.name);
    setCropTypes((c) => (c.some((x) => x.id === created.id) ? c : [...c, created]));
    return created;
  }

  async function resolveVariety(cropTypeId: string, item: CatalogItem): Promise<CatalogItem> {
    if (item.id !== "__new__") return item;
    const created = await api.createVariety(cropTypeId, item.name);
    setVarieties((v) => (v.some((x) => x.id === created.id) ? v : [...v, created]));
    return created;
  }

  async function save() {
    if (!validateStep2()) return;
    // `plotId` is already stable across clicks — `useState(() => id ?? uuidv7())`
    // — so the server's idempotency covers the data. This is the other half:
    // the second request that never leaves. See `lib/writeOnce.ts`.
    const outcome = await runOnce(`parcela|${plotId}|${name.trim()}|${parsedArea}`, async () => {
      setError(null);
      const crops: PlotInput["crops"] = [];
      for (const r of rows) {
        if (!r.cropType) continue;
        const type = await resolveCropType(r.cropType);
        const variety = r.variety ? await resolveVariety(type.id, r.variety) : null;
        const area = r.areaHa.trim()
          ? Number(r.areaHa.replace(/\./g, "").replace(",", "."))
          : null;
        crops.push({
          id: r.id,
          cropTypeId: type.id,
          varietyId: variety?.id ?? null,
          areaHa: Number.isFinite(area as number) ? (area as number) : null,
          plantedAt: r.plantedAt || null,
        });
      }
      const body: PlotInput = {
        id: plotId,
        name: name.trim(),
        department,
        municipality: municipality.trim(),
        areaHa: parsedArea,
        // Absent when the map was never touched: on this route an absent
        // boundary keeps whatever is stored, and sending a null would be
        // indistinguishable from it anyway.
        ...(boundary ? { boundary } : {}),
        crops,
      };
      return editing ? api.updatePlot(plotId, body) : api.createPlot(body);
    }).catch((e: unknown) => {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) setFields(e.fieldErrors);
      setError(messageFor(e));
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    navigate(`/parcelas/${outcome.value.id}`, { replace: true });
  }

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate("/parcelas")}
        sx={{ mb: 1 }}
        color="inherit"
      >
        Parcelas
      </Button>
      <Typography variant="h1" gutterBottom>
        {editing ? "Modificar parcela" : "Nueva parcela"}
      </Typography>

      <Stepper activeStep={step} sx={{ maxWidth: 520, my: 3 }}>
        <Step>
          <StepLabel>Identidad y ubicación</StepLabel>
        </Step>
        <Step>
          <StepLabel>Cultivos</StepLabel>
        </Step>
      </Stepper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {step === 0 && (
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, md: 7 }}>
            <Card>
              <CardContent>
                <Stack spacing={2.5}>
                  <TextField
                    label="Nombre del lote"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    error={!!fields.name}
                    helperText={fields.name}
                    size="medium"
                    fullWidth
                    autoFocus
                    required
                    slotProps={{ htmlInput: { maxLength: 80 } }}
                  />
                  <TextField
                    label="Superficie total (hectáreas)"
                    value={areaHa}
                    onChange={(e) => setAreaHa(e.target.value)}
                    error={!!fields.areaHa}
                    helperText={fields.areaHa ?? "Lo que usted declara. Ejemplo: 4,20"}
                    size="medium"
                    fullWidth
                    required
                    inputMode="decimal"
                  />
                  <Grid container spacing={2}>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <TextField
                        select
                        label="Departamento"
                        value={department}
                        onChange={(e) => setDepartment(e.target.value)}
                        size="medium"
                        fullWidth
                        required
                      >
                        {DEPARTMENTS.map((d) => (
                          <MenuItem key={d} value={d}>
                            {d}
                          </MenuItem>
                        ))}
                      </TextField>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <TextField
                        label="Municipio"
                        value={municipality}
                        onChange={(e) => setMunicipality(e.target.value)}
                        error={!!fields.municipality}
                        helperText={fields.municipality}
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
                <Typography variant="h3" gutterBottom>
                  Mapa del lote
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Opcional. Marque las esquinas y el sistema calcula las hectáreas del
                  polígono, que quedan junto a las que usted declara arriba.
                </Typography>
                {mapReady && (
                  <PlotBoundaryEditor
                    plotId={plotId}
                    initialBoundary={loadedBoundary}
                    neighbours={neighbours}
                    declaredAreaHa={Number.isFinite(parsedArea) ? parsedArea : null}
                    height={300}
                    onChange={setBoundary}
                  />
                )}
                {drawnAreaHa !== null && (
                  <Alert severity="info" sx={{ mt: 2 }}>
                    El polígono mide {formatArea(drawnAreaHa)} ha
                    {Number.isFinite(parsedArea) && parsedArea > 0
                      ? ` y usted declaró ${formatArea(parsedArea)} ha. Las dos se guardan.`
                      : "."}
                  </Alert>
                )}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}

      {step === 1 && (
        <Card>
          <CardContent>
            <Typography variant="h3" gutterBottom>
              Cultivos de la parcela
            </Typography>
            <Typography color="text.secondary" variant="body2" sx={{ mb: 2 }}>
              Si el tipo o la variedad no están en la lista, escríbalos y se agregan
              al catálogo de la finca.
            </Typography>

            {fields.crops && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                {fields.crops}
              </Alert>
            )}

            <Stack spacing={2}>
              {rows.map((row, i) => (
                <Grid container spacing={2} key={row.key} alignItems="flex-start">
                  <Grid size={{ xs: 12, sm: 4 }}>
                    <Autocomplete
                      value={row.cropType}
                      options={cropTypes}
                      getOptionLabel={(o) => o.name}
                      isOptionEqualToValue={(a, b) => a.id === b.id}
                      filterOptions={(options, state) =>
                        withCreateOption(filter(options, state), state.inputValue)
                      }
                      renderOption={(props, option) => (
                        <li {...props} key={option.id + option.name}>
                          {option.id === "__new__" ? `Agregar «${option.name}»` : option.name}
                        </li>
                      )}
                      onChange={(_, v) =>
                        setRows((rs) =>
                          rs.map((r, j) =>
                            j === i ? { ...r, cropType: v, variety: null } : r,
                          ),
                        )
                      }
                      renderInput={(params) => (
                        <TextField {...params} label="Tipo de cultivo" size="medium" required />
                      )}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 4 }}>
                    <Autocomplete
                      value={row.variety}
                      disabled={!row.cropType}
                      options={varieties.filter(
                        (v) => !row.cropType || v.cropTypeId === row.cropType.id,
                      )}
                      getOptionLabel={(o) => o.name}
                      isOptionEqualToValue={(a, b) => a.id === b.id}
                      filterOptions={(options, state) =>
                        withCreateOption(filter(options, state), state.inputValue)
                      }
                      renderOption={(props, option) => (
                        <li {...props} key={option.id + option.name}>
                          {option.id === "__new__" ? `Agregar «${option.name}»` : option.name}
                        </li>
                      )}
                      onChange={(_, v) =>
                        setRows((rs) => rs.map((r, j) => (j === i ? { ...r, variety: v } : r)))
                      }
                      renderInput={(params) => (
                        <TextField {...params} label="Variedad" size="medium" />
                      )}
                    />
                  </Grid>
                  <Grid size={{ xs: 6, sm: 2 }}>
                    <TextField
                      label="Área (ha)"
                      value={row.areaHa}
                      onChange={(e) =>
                        setRows((rs) =>
                          rs.map((r, j) => (j === i ? { ...r, areaHa: e.target.value } : r)),
                        )
                      }
                      size="medium"
                      fullWidth
                      inputMode="decimal"
                    />
                  </Grid>
                  <Grid size={{ xs: 5, sm: 1.5 }}>
                    <TextField
                      label="Siembra"
                      type="date"
                      value={row.plantedAt}
                      onChange={(e) =>
                        setRows((rs) =>
                          rs.map((r, j) => (j === i ? { ...r, plantedAt: e.target.value } : r)),
                        )
                      }
                      size="medium"
                      fullWidth
                      slotProps={{ inputLabel: { shrink: true } }}
                    />
                  </Grid>
                  <Grid size={{ xs: 1, sm: 0.5 }}>
                    <IconButton
                      aria-label={`Quitar cultivo ${i + 1}`}
                      onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                      sx={{ mt: 1 }}
                    >
                      <DeleteOutlineIcon />
                    </IconButton>
                  </Grid>
                </Grid>
              ))}
            </Stack>

            <Button
              startIcon={<AddIcon />}
              sx={{ mt: 2 }}
              onClick={() =>
                setRows((rs) => [
                  ...rs,
                  { key: uuidv7(), id: uuidv7(), cropType: null, variety: null, areaHa: "", plantedAt: "" },
                ])
              }
            >
              Agregar otro cultivo
            </Button>
          </CardContent>
        </Card>
      )}

      <Stack direction="row" spacing={2} sx={{ mt: 3 }} justifyContent="flex-end">
        {step === 1 && (
          <Button color="inherit" onClick={() => setStep(0)}>
            Atrás
          </Button>
        )}
        {step === 0 && (
          <Button
            variant="contained"
            onClick={() => {
              if (validateStep1()) setStep(1);
            }}
          >
            Continuar
          </Button>
        )}
        {step === 1 && (
          <Button variant="contained" onClick={save} disabled={busy}>
            {busy ? "Guardando…" : "Guardar parcela"}
          </Button>
        )}
      </Stack>
    </Box>
  );
}
