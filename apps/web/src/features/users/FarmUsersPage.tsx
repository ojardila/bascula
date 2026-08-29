/**
 * GESTIÓN DE USUARIOS — who can get into this farm, and as what.
 *
 * Until now the only way to create a user was to register a whole new farm,
 * which meant an owner who hired a foreman had no way to give him a login.
 * `docs/casos-de-uso.md` §8 lists this as "listar y agregar usuarios" and then
 * says "pendiente de detallar"; `docs/arquitectura-api.md` §329 answers it
 * with the minimum that unblocks — `GET|POST|PATCH /v1/users`, owner only.
 *
 * OWNER ONLY, AND NOT ADMINISTRATOR. `docs/diagramas/sistema.md` §3.3 puts
 * "gestión de usuarios de la finca" in the owner column and leaves the
 * administrator's blank, which is stricter than `casos-de-uso.md` reads on its
 * own — the same tightening that took price-setting and deletion off the
 * administrator. `permissions.ts` has said so since Sprint 1: `config.users`
 * is in OWNER and in neither of the others.
 *
 * ── THE SERVER DOES NOT SERVE THIS YET ──────────────────────────────────
 *
 * `routes.go` has no `/v1/users`, and the running build answers 404. That is
 * why this screen exists in the state it does, and the shape of the honesty
 * matters more than the shape of the form:
 *
 *   IT NEVER SHOWS AN EMPTY LIST. An empty table under "Usuarios de la finca"
 *   says this farm has nobody in it, which is false of every farm — somebody
 *   is logged in reading it. So a missing route produces a named refusal,
 *   with the routes it is waiting for, and no table at all.
 *
 *   IT NEVER PRETENDS A WRITE WORKED. The invite form posts and reports what
 *   came back. There is no optimistic row, because a row that appears and
 *   vanishes on reload is worse than a refusal.
 *
 * Against the mock (`VITE_USE_MOCKS=true`) the whole screen works, which is
 * how the design was reviewed. When the routes land this file does not change.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, AlertTitle, Box, Button, Card, CardContent, Chip, Dialog, DialogActions,
  DialogContent, DialogTitle, MenuItem, Stack, Table, TableBody, TableCell, TableHead,
  TableRow, TextField, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import { PermissionDenied } from "../../components/Guards";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useAsync } from "../../lib/useAsync";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { formatDate } from "../../lib/dates";
import { uuidv7 } from "../../lib/uuid";
import type { FarmUser, FarmUserStatus, Role } from "../../api/types";

/**
 * The two roles an owner hands out, with what each one actually opens. Written
 * out because "administrador" and "pesador" mean nothing to somebody choosing
 * between them, and the wrong choice here hands the payroll to whoever is
 * holding the scale this season.
 *
 * `owner` is deliberately NOT offered. There is one owner, the farm was
 * registered under them, and a second owner is a decision with consequences
 * (deleting, prices, the whole ledger) that this form has no business making
 * casually.
 */
const ROLES: { value: Role; label: string; blurb: string }[] = [
  {
    value: "administrator",
    label: "Administrador",
    blurb:
      "El día a día: registra labores, liquida, paga y corrige. No cambia precios " +
      "ni da de baja a nadie.",
  },
  {
    value: "weigher",
    label: "Pesador",
    blurb:
      "Registra pesadas y ve lo que él mismo registró. No ve plata, ni saldos, ni " +
      "las cifras de los demás.",
  },
];

const STATUS_CHIP: Record<
  FarmUserStatus,
  { label: string; color: "default" | "success" | "warning" | "error" }
> = {
  active: { label: "Activo", color: "success" },
  invited: { label: "Invitado, sin confirmar", color: "warning" },
  revoked: { label: "Sin acceso", color: "error" },
  // The server sent something this build does not know. Say so; do not guess
  // "activo", which would be a claim that somebody can log in.
  unknown: { label: "—", color: "default" },
};

const ROLE_LABEL: Record<Role, string> = {
  owner: "Dueño",
  administrator: "Administrador",
  weigher: "Pesador",
};

export function FarmUsersPage() {
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const [inviting, setInviting] = useState(false);
  const [revoking, setRevoking] = useState<FarmUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const { data, error, denied } = useAsync(() => api.listFarmUsers(), [tick]);
  const reload = () => setTick((t) => t + 1);

  if (!can("config.users")) return <PermissionDenied moduleName="gestionar los usuarios" />;
  if (denied) return <PermissionDenied moduleName="gestionar los usuarios" />;

  const unsupported = error !== null && data === null;

  async function changeRole(u: FarmUser, role: Role) {
    setBusy(true);
    setActionError(null);
    try {
      await api.updateFarmUser(u.id, { role });
      reload();
    } catch (e) {
      setActionError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.updateFarmUser(revoking.id, { status: "revoked" });
      setRevoking(null);
      reload();
    } catch (e) {
      setActionError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate("/configuracion")}
        color="inherit"
        sx={{ mb: 1 }}
      >
        Configuración
      </Button>

      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ sm: "center" }}
        spacing={2}
        sx={{ mb: 3 }}
      >
        <Box>
          <Typography variant="h1">Usuarios de la finca</Typography>
          <Typography color="text.secondary">
            Quién puede entrar a {user?.farm.name} y con qué permisos.
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<PersonAddIcon />}
          disabled={unsupported}
          onClick={() => setInviting(true)}
        >
          Invitar a alguien
        </Button>
      </Stack>

      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      {/* The route is not there. Named, with what it is waiting for — and NOT
          an empty table, which would say this farm has nobody in it. */}
      {unsupported && (
        <Alert severity="info" variant="outlined">
          <AlertTitle>Esta parte todavía no está en el servidor</AlertTitle>
          {error}
          <Box sx={{ mt: 1.5 }}>
            La consola ya sabe pedirla: <code>GET /v1/users</code> para listarlos,{" "}
            <code>POST /v1/users</code> para invitar y <code>PATCH /v1/users/{"{id}"}</code>{" "}
            para cambiar el rol o quitar el acceso. En cuanto el servidor las responda,
            esta pantalla funciona sin tocar nada.
          </Box>
          <Box sx={{ mt: 1.5 }}>
            Mientras tanto, la única forma de crear un usuario sigue siendo registrar una
            finca nueva.
          </Box>
        </Alert>
      )}

      {!unsupported && error && <Alert severity="error">{error}</Alert>}

      {!unsupported && !error && (
        <Card>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Persona</TableCell>
                <TableCell>Rol</TableCell>
                <TableCell>Estado</TableCell>
                <TableCell>Última entrada</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {data === null && (
                <TableRow>
                  <TableCell colSpan={5} sx={{ color: "text.secondary" }}>
                    Cargando…
                  </TableCell>
                </TableRow>
              )}
              {data?.map((u) => {
                const isMe = u.id === user?.id;
                const isOwner = u.role === "owner";
                return (
                  <TableRow key={u.id} sx={{ opacity: u.status === "revoked" ? 0.55 : 1 }}>
                    <TableCell>
                      <Stack>
                        <Typography sx={{ fontWeight: 600 }}>
                          {u.name || "—"}
                          {isMe && (
                            <Chip size="small" label="usted" sx={{ ml: 1, height: 20 }} />
                          )}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {u.email}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {/* The owner's role is not editable here and neither is
                          your own: a farm with no owner, or an owner who has
                          just demoted themselves, is a farm nobody can
                          administer. The server enforces it too. */}
                      {isOwner || isMe ? (
                        <Typography>{ROLE_LABEL[u.role]}</Typography>
                      ) : (
                        <TextField
                          select
                          size="small"
                          value={u.role}
                          disabled={busy || u.status === "revoked"}
                          onChange={(e) => changeRole(u, e.target.value as Role)}
                          sx={{ minWidth: 160 }}
                        >
                          {ROLES.map((r) => (
                            <MenuItem key={r.value} value={r.value}>
                              {r.label}
                            </MenuItem>
                          ))}
                        </TextField>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={STATUS_CHIP[u.status].color}
                        label={STATUS_CHIP[u.status].label}
                      />
                    </TableCell>
                    <TableCell>
                      {/* Never a date for somebody who has never logged in. */}
                      {u.lastLoginAt ? (
                        formatDate(u.lastLoginAt.slice(0, 10))
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          Nunca ha entrado
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      {!isOwner && !isMe && u.status !== "revoked" && (
                        <Button
                          size="small"
                          color="error"
                          disabled={busy}
                          onClick={() => setRevoking(u)}
                        >
                          Quitar acceso
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} sx={{ color: "text.secondary" }}>
                    El servidor no devolvió ningún usuario para esta finca.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      <Card variant="outlined" sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h3" gutterBottom>
            Qué abre cada rol
          </Typography>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            {ROLES.map((r) => (
              <Box key={r.value}>
                <Typography sx={{ fontWeight: 600 }}>{r.label}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {r.blurb}
                </Typography>
              </Box>
            ))}
            <Box>
              <Typography sx={{ fontWeight: 600 }}>Dueño</Typography>
              <Typography variant="body2" color="text.secondary">
                Todo, incluidos los precios, dar de baja y la cuenta de cada empleado. No
                se reparte desde aquí.
              </Typography>
            </Box>
          </Stack>
          <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
            Esconder un botón no es un permiso. El rol se aplica también en el servidor,
            porque un teléfono se presta y una sesión se comparte.
          </Alert>
        </CardContent>
      </Card>

      <InviteDialog
        open={inviting}
        onClose={() => setInviting(false)}
        onDone={() => {
          setInviting(false);
          reload();
        }}
      />

      <ConfirmDialog
        open={!!revoking}
        title="¿Quitar el acceso?"
        body={
          `${revoking?.name || revoking?.email} no podrá volver a entrar a la finca. ` +
          `Su usuario no se borra: todo lo que registró sigue con su nombre, que es lo ` +
          `que hace auditable el libro. Puede devolverle el acceso después.`
        }
        confirmLabel="Sí, quitar el acceso"
        busy={busy}
        destructive
        onCancel={() => setRevoking(null)}
        onConfirm={revoke}
      />
    </Box>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The invitation.
 *
 * The role is chosen with its consequence next to it, not from a bare dropdown
 * of two words. This is the one form in the console where picking the wrong
 * option hands somebody the payroll.
 */
function InviteDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("weigher");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const reset = () => {
    setEmail("");
    setName("");
    setRole("weigher");
    setError(null);
    setFields({});
  };

  async function submit() {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await api.inviteFarmUser({ id: uuidv7(), email, name, role });
      reset();
      onDone();
    } catch (e) {
      if (e instanceof ApiError) setFields(e.fieldErrors);
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  const chosen = ROLES.find((r) => r.value === role);

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>Invitar a alguien a la finca</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Correo"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            fullWidth
            autoFocus
            error={!!fields.email}
            helperText={
              fields.email ??
              "Le llega un correo para poner su contraseña. Nadie más ve esa contraseña."
            }
          />
          <TextField
            label="Nombre"
            value={name}
            onChange={(e) => setName(e.target.value)}
            fullWidth
            error={!!fields.name}
            helperText={fields.name ?? " "}
          />
          <TextField
            select
            label="Rol"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            fullWidth
            helperText={chosen?.blurb ?? " "}
          >
            {ROLES.map((r) => (
              <MenuItem key={r.value} value={r.value}>
                {r.label}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} color="inherit">
          Cancelar
        </Button>
        <Button
          variant="contained"
          onClick={submit}
          disabled={busy || email.trim() === "" || name.trim() === ""}
        >
          {busy ? "Invitando…" : "Enviar la invitación"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
