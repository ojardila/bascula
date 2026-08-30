/**
 * The farm's units of collection.
 *
 * The owner's words: "Precio del kilo es muy especifico no siempre tendremos
 * la misma unidad ademas no hay forma de borrar o edidtar". The table has held
 * these since migration 00004 with one door in and none out -- create and list,
 * nothing else -- so a farm that typed "canata" lived with it and a unit it
 * stopped using stayed in every picker forever.
 *
 * The one thing this screen must never do is lie about what a button does.
 * Removing a unit nothing references deletes it; removing one that any work
 * record references RETIRES it, because destroying it would leave a row saying
 * "40" of something nobody can name -- in the row that decided what a picker
 * was paid. The screen says which of the two will happen BEFORE it is pressed,
 * and says which one happened after.
 */
import { useState } from "react";
import {
  Alert, Box, Button, Card, CardContent, Chip, Dialog, DialogActions,
  DialogContent, DialogTitle, IconButton, Stack, TextField, Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { api } from "../../api/endpoints";
import type { WorkUnit } from "../../api/types";
import { useAsync } from "../../lib/useAsync";
import { useAuth } from "../../auth/AuthContext";
import { PermissionDenied } from "../../components/Guards";
import { messageFor } from "../../api/errors";

/** What one of these weighs, written the way the farm writes numbers. */
function factorText(u: WorkUnit): string {
  if (u.kgFactor === null) return "No se convierte a kilos";
  return `1 ${u.label.toLowerCase()} = ${String(u.kgFactor).replace(".", ",")} kg`;
}

export function WorkUnitsPage() {
  const { can } = useAuth();
  const [reload, setReload] = useState(0);
  const { data: units, error } = useAsync(() => api.workUnits(), [reload]);
  const [editing, setEditing] = useState<WorkUnit | "new" | null>(null);
  const [removing, setRemoving] = useState<WorkUnit | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // The server gates these routes on `catalogs.read` / `catalogs.write`, which
  // the web's Action union does not carry. Both are granted to exactly the same
  // roles as `activities.*` (owner and admin, `internal/auth/perm.go:226,231`),
  // and a work unit IS part of the activity catalogue there -- same handler
  // file. So this is the same gate under the name the web already has, not a
  // looser one.
  if (!can("activities.read")) return <PermissionDenied moduleName="ver las unidades" />;
  const mayWrite = can("activities.write");

  async function remove(u: WorkUnit) {
    setFailed(null);
    try {
      const r = await api.deleteWorkUnit(u.id);
      // The server decides which happened. Reporting a deletion that was a
      // retirement is the one thing this screen must not do.
      setSaid(
        r.archived
          ? `«${u.label}» se guardó en el historial. Ya no aparece al registrar, ` +
            `y todo lo que se pesó en esa unidad se sigue viendo igual.`
          : `«${u.label}» se borró. Nadie la había usado todavía.`,
      );
      setRemoving(null);
      setReload((n) => n + 1);
    } catch (e) {
      setFailed(messageFor(e));
    }
  }

  return (
    <Box>
      <Typography variant="h2" gutterBottom>
        Unidades de recolección
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Cómo cuenta la finca lo que se recoge. El kilo es una, pero no la única: hay
        fincas que cuentan por arroba, por canasta o por bulto.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {failed && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setFailed(null)}>{failed}</Alert>}
      {said && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSaid(null)}>{said}</Alert>}

      {mayWrite && (
        <Button
          variant="contained"
          size="large"
          startIcon={<AddIcon />}
          onClick={() => setEditing("new")}
          sx={{ mb: 3 }}
        >
          Agregar una unidad
        </Button>
      )}

      <Stack spacing={2}>
        {(units ?? []).map((u) => (
          <Card key={u.id}>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                    <Typography variant="h3">{u.label}</Typography>
                    <Chip size="small" label={u.code} />
                    {u.inUse && <Chip size="small" color="primary" variant="outlined" label="En uso" />}
                  </Stack>
                  <Typography color="text.secondary" variant="body2">
                    {factorText(u)}
                  </Typography>
                </Box>
                {mayWrite && (
                  <Stack direction="row" spacing={0.5}>
                    <IconButton aria-label={`Editar ${u.label}`} onClick={() => setEditing(u)}>
                      <EditIcon />
                    </IconButton>
                    <IconButton aria-label={`Quitar ${u.label}`} onClick={() => setRemoving(u)}>
                      <DeleteOutlineIcon />
                    </IconButton>
                  </Stack>
                )}
              </Stack>
            </CardContent>
          </Card>
        ))}
        {units && units.length === 0 && (
          <Typography color="text.secondary">
            Esta finca todavía no tiene ninguna unidad.
          </Typography>
        )}
      </Stack>

      {editing && (
        <UnitDialog
          unit={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setSaid(msg);
            setReload((n) => n + 1);
          }}
        />
      )}

      <Dialog open={removing !== null} onClose={() => setRemoving(null)}>
        <DialogTitle>Quitar «{removing?.label}»</DialogTitle>
        <DialogContent>
          {/* The whole point: say which of the two things will happen, in
              words, before the person commits to it. */}
          {removing?.inUse ? (
            <Typography>
              Esta unidad ya se usó para pesar. No se puede borrar, porque los registros
              que la usaron quedarían sin sentido y esos registros decidieron pagos.
              <br />
              <br />
              Lo que va a pasar: <strong>se guarda en el historial</strong>. Deja de
              aparecer al registrar trabajo, y todo lo ya pesado se sigue viendo igual.
            </Typography>
          ) : (
            <Typography>
              Nadie ha usado esta unidad todavía, así que <strong>se borra</strong> y no
              queda rastro. Si después la necesita, la vuelve a crear.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoving(null)}>Cancelar</Button>
          <Button
            variant="contained"
            color={removing?.inUse ? "primary" : "error"}
            onClick={() => removing && remove(removing)}
          >
            {removing?.inUse ? "Guardar en el historial" : "Borrar"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function UnitDialog({
  unit,
  onClose,
  onSaved,
}: {
  unit: WorkUnit | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [label, setLabel] = useState(unit?.label ?? "");
  const [code, setCode] = useState(unit?.code ?? "");
  const [factor, setFactor] = useState(
    unit?.kgFactor === null || unit?.kgFactor === undefined
      ? ""
      : String(unit.kgFactor).replace(".", ","),
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const parsed = factor.trim() === "" ? null : Number(factor.replace(",", "."));
  const factorIsBad = parsed !== null && (!Number.isFinite(parsed) || parsed <= 0);

  async function save() {
    setFailed(null);
    setBusy(true);
    try {
      if (unit) {
        await api.updateWorkUnit(unit.id, {
          code: code.trim(),
          label: label.trim(),
          // Always sent when editing, because the field was on screen and
          // emptying it is a decision. On create the same value is sent once.
          kgFactor: parsed,
        });
        onSaved(`«${label.trim()}» quedó guardada.`);
      } else {
        await api.createWorkUnit({
          code: code.trim() || label.trim().toLowerCase(),
          label: label.trim(),
          kgFactor: parsed,
        });
        onSaved(`«${label.trim()}» quedó creada.`);
      }
    } catch (e) {
      setFailed(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{unit ? "Editar la unidad" : "Nueva unidad"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {failed && <Alert severity="error">{failed}</Alert>}
          <TextField
            label="Cómo se llama"
            placeholder="Canasta"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            fullWidth
            required
            autoFocus
          />
          <TextField
            label="Abreviatura"
            placeholder="canasta"
            helperText="Cómo aparece en las listas cuando no cabe el nombre completo."
            value={code}
            onChange={(e) => setCode(e.target.value)}
            fullWidth
          />
          <TextField
            label="Cuántos kilos pesa una"
            placeholder="12,5"
            value={factor}
            onChange={(e) => setFactor(e.target.value)}
            error={factorIsBad}
            helperText={
              factorIsBad
                ? "Escriba un número mayor que cero, por ejemplo 12,5"
                : "Déjelo vacío si esta unidad no se convierte a kilos, como un jornal."
            }
            fullWidth
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancelar</Button>
        <Button
          variant="contained"
          onClick={save}
          disabled={busy || label.trim() === "" || factorIsBad}
        >
          {busy ? "Guardando…" : "Guardar"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
