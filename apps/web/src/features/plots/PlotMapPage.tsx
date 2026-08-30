/**
 * RSP-001's "Mapa — polígono (dato SIG)", on its own screen.
 *
 * It is a screen and not a dialog for three reasons. Drawing needs the width;
 * `PUT /v1/plots/{id}/boundary` is a write of its own with its own failure
 * (INVALID_GEOMETRY) and its own non-failure (`overlaps`), and both deserve
 * somewhere to be said; and a person redrawing a boundary is doing one job for
 * several minutes, which is a page, not a modal.
 *
 * WHAT HAPPENS TO THE TWO AREAS. The declared figure is never touched here.
 * The server recomputes its own on every write and answers with both, and this
 * screen shows both before and after: the point is not to make them agree, it
 * is to make the difference visible enough that the owner can decide what to
 * do about it — including nothing.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, Stack, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { PlotBoundaryEditor, type MapNeighbour } from "./PlotBoundaryEditor";
import { AreaComparison } from "./AreaComparison";
import { LOTE } from "../../lib/vocab";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { PermissionDenied } from "../../components/Guards";
import { areaHaOfRing, asGeometry, openRing, outerRings, type PolygonGeometry } from "../../lib/geo";
import type { CatalogItem } from "../../api/types";

export function PlotMapPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();

  const { data: plots, error, denied } = useAsync(() => api.listPlots({ status: "all" }), [id]);
  const plot = plots?.find((p) => p.id === id) ?? null;

  const [draft, setDraft] = useState<PolygonGeometry | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAreaHa, setSavedAreaHa] = useState<number | null | undefined>(undefined);
  const [overlaps, setOverlaps] = useState<CatalogItem[]>([]);
  const [done, setDone] = useState(false);

  if (denied) return <PermissionDenied moduleName="ver este lote" />;
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!plots) return null;
  if (!plot) return <Alert severity="error">No encontramos ese lote.</Alert>;

  const readOnly = !can("plots.write");

  /**
   * Every other live plot that has a polygon, drawn behind this one in grey.
   * This is the layer that does the work a satellite photo would have done:
   * for the second lot onwards, the line that matters is the neighbour's.
   */
  const neighbours: MapNeighbour[] = plots.flatMap((p) => {
    if (p.id === plot.id || p.status === "inactive") return [];
    const g = asGeometry(p.boundary);
    return g ? [{ id: p.id, name: p.name, boundary: g }] : [];
  });

  /** What the map is showing right now: the draft if there is one, else the stored shape. */
  const shown = draft === undefined ? asGeometry(plot.boundary) : draft;
  const shownRing = shown ? openRing(outerRings(shown)[0] ?? []) : [];
  const liveAreaHa = shownRing.length >= 3 ? areaHaOfRing(shownRing) : null;
  const dirty = draft !== undefined;

  async function save() {
    if (!plot || draft === undefined) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (draft === null) {
        // Nothing to store. The server has no "erase the boundary" route —
        // `boundary` is required on the PUT — so this is said rather than
        // faked with an empty polygon that PostGIS would refuse anyway.
        setSaveError(
          "No hay ningún polígono que guardar. Marque al menos tres esquinas, o vuelva atrás para dejar el lote como estaba.",
        );
        return;
      }
      const result = await api.setPlotBoundary(plot.id, draft);
      setSavedAreaHa(result.plot.computedAreaHa);
      setOverlaps(result.overlaps);
      setDraft(undefined);
      setDone(true);
    } catch (e) {
      // INVALID_GEOMETRY lands here in Spanish and stays on this screen, next
      // to the drawing that caused it. The editor has usually said it already,
      // in red, on the two sides that cross — this is the belt to that
      // bracing, for the shapes PostGIS refuses and we did not think of.
      setSaveError(
        e instanceof ApiError && e.code === "INVALID_GEOMETRY"
          ? `${e.spanishMessage} (el servidor dice: ${e.message})`
          : messageFor(e),
      );
    } finally {
      setSaving(false);
    }
  }

  const computedShown = savedAreaHa !== undefined ? savedAreaHa : plot.computedAreaHa;

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate(`${LOTE.path}/${plot.id}`)}
        color="inherit"
        sx={{ mb: 1 }}
      >
        {plot.name}
      </Button>

      <Typography variant="h1" gutterBottom>
        Polígono de {plot.name}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        {plot.department} · {plot.municipality}
      </Typography>

      {saveError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setSaveError(null)}>
          {saveError}
        </Alert>
      )}
      {done && !dirty && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setDone(false)}>
          El polígono quedó guardado y el servidor volvió a medir sus hectáreas.
        </Alert>
      )}

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <PlotBoundaryEditor
            plotId={plot.id}
            initialBoundary={plot.boundary}
            neighbours={neighbours}
            overlaps={overlaps}
            declaredAreaHa={plot.areaHa}
            readOnly={readOnly}
            height={480}
            onChange={setDraft}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="overline" color="text.secondary">
            Superficie
          </Typography>
          <Box sx={{ mt: 1 }}>
            <AreaComparison
              declaredHa={plot.areaHa}
              computedHa={dirty ? liveAreaHa : computedShown}
              provisional={dirty}
            />
          </Box>
          {dirty && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2 }}>
              Esta medida la está calculando su navegador mientras dibuja. Al guardar, la
              vuelve a calcular el servidor y esa es la que queda.
            </Typography>
          )}
        </CardContent>
      </Card>

      {!readOnly && (
        <Stack direction="row" spacing={2} sx={{ mt: 3 }} justifyContent="flex-end">
          <Button color="inherit" onClick={() => navigate(`${LOTE.path}/${plot.id}`)}>
            {dirty ? "Salir sin guardar" : "Volver"}
          </Button>
          <Button variant="contained" onClick={save} disabled={!dirty || saving}>
            {saving ? "Guardando…" : "Guardar el polígono"}
          </Button>
        </Stack>
      )}
    </Box>
  );
}
