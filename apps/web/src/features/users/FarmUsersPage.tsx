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
 * ── THE SERVER SERVES THIS NOW ─────────────────────────────────────────
 *
 * `routes.go` has `/v1/users` and the running build answers 200 — checked,
 * not assumed. The paragraph that used to stand here said there was no route
 * and the build answered 404; it was true when written and nobody deleted it
 * when the route landed. The refusal path below is kept as a floor for an
 * older server, and the two rules it was built on still hold:
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
import { useWriteOnce } from "../../lib/writeOnce";
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
  // A PATCH of a role is idempotent by nature, so nothing here could ever
  // double-write. The guard keeps one answer to "can this button fire twice"
  // across the whole console rather than two.
  const { busy, run: runOnce } = useWriteOnce();
  const [actionError, setActionError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const { data, error, denied } = useAsync(() => api.listFarmUsers(), [tick]);
  const reload = () => setTick((t) => t + 1);

  if (!can("config.users")) return <PermissionDenied moduleName="gestionar los usuarios" />;
  if (denied) return <PermissionDenied moduleName="gestionar los usuarios" />;

  const unsupported = error !== null && data === null;

  async function changeRole(u: FarmUser, role: Role) {
    const outcome = await runOnce(`rol|${u.id}|${role}`, async () => {
      setActionError(null);
      return api.updateFarmUser(u.id, { role });
    }).catch((e: unknown) => {
      setActionError(messageFor(e));
      return { ran: false } as const;
    });
    if (outcome.ran) reload();
  }

  async function revoke() {
    if (!revoking) return;
    const who = revoking.id;
    const outcome = await runOnce(`revocar|${who}`, async () => {
      setActionError(null);
      return api.updateFarmUser(who, { status: "revoked" });
    }).catch((e: unknown) => {
      setActionError(messageFor(e));
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    setRevoking(null);
    reload();
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
                      {/* THREE CASES, and the third is the one that bit.
                          `/v1/users` does not send a last login at all, so
                          `undefined` means "not reported" — and printing that
                          as "nunca ha entrado" told the owner he had never
                          logged in while he was reading the screen. A date is
                          a date, `null` is genuinely never, absent is "—". */}
                      {u.lastLoginAt === undefined ? (
                        <Typography variant="body2" color="text.secondary" title="El servidor no informa la última entrada.">
                          —
                        </Typography>
                      ) : u.lastLoginAt === null ? (
                        <Typography variant="body2" color="text.secondary">
                          Nunca ha entrado
                        </Typography>
                      ) : (
                        formatDate(u.lastLoginAt.slice(0, 10))
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
        /* Reloads the list but does NOT close the dialog: the invitation's
           reply carries the one and only copy of the person's password, and
           closing over it would destroy it. The dialog closes itself once the
           credential has been acknowledged. */
        onDone={reload}
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
 *
 * ── THERE IS NO EMAIL, AND THIS SCREEN USED TO PROMISE ONE ──────────────
 *
 * The helper text said "Le llega un correo para poner su contraseña". There is
 * no mail sender in `services/api` and there never was; `handleInviteUser`
 * mints a password, hashes it, and returns the plaintext in the invite
 * response ONCE, with a note saying it cannot be read again. `toFarmUser` then
 * dropped that field on the floor. Between the two, every person invited from
 * this console was given an account they could never log into and a promise of
 * a letter nobody would send.
 *
 * So the dialog now has two phases. The form, and then the credential — shown
 * in full, with the warning that this is the only time it exists, and the
 * dialog deliberately not closing on its own so it cannot be dismissed before
 * it has been written down.
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
  const { busy, run: runOnce } = useWriteOnce();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  /** Phase two: the account exists and this is the only copy of its password. */
  const [invited, setInvited] = useState<FarmUser | null>(null);

  const reset = () => {
    setEmail("");
    setName("");
    setRole("weigher");
    setError(null);
    setFields({});
    setInvited(null);
  };

  async function submit() {
    setFields({});
    // One membership per filled-in form. The id used to be minted inside the
    // call, so a double click sent two different ids for the same person.
    // See `lib/writeOnce.ts`.
    const intent = ["invitar", email.trim().toLowerCase(), name.trim(), role].join("|");
    const outcome = await runOnce(intent, async (mint) => {
      setError(null);
      return api.inviteFarmUser({ id: mint(), email, name, role });
    }).catch((e: unknown) => {
      if (e instanceof ApiError) setFields(e.fieldErrors);
      setError(messageFor(e));
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    // The list behind the dialog refreshes now; the dialog itself stays open
    // on the credential, because closing it would destroy the password.
    onDone();
    setInvited(outcome.value);
  }

  function finish() {
    reset();
    onClose();
  }

  const chosen = ROLES.find((r) => r.value === role);

  // ── PHASE TWO: the credential ──────────────────────────────────────
  if (invited) {
    return (
      <Dialog open={open} onClose={finish} maxWidth="sm" fullWidth>
        <DialogTitle>{invited.name || invited.email} ya tiene acceso</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {invited.temporaryPassword ? (
              <>
                <Alert severity="warning">
                  <AlertTitle>Apunte esta contraseña ahora</AlertTitle>
                  Es la única vez que se puede ver. El servidor solo guarda una
                  versión cifrada, así que ni nosotros podemos volver a leerla. Si
                  se pierde, hay que crear la contraseña de nuevo.
                </Alert>
                <Box>
                  <Typography variant="overline" color="text.secondary">
                    Correo
                  </Typography>
                  <Typography sx={{ fontFamily: "monospace", fontSize: "1.05rem" }}>
                    {invited.email}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="overline" color="text.secondary">
                    Contraseña temporal
                  </Typography>
                  <Typography
                    sx={{
                      fontFamily: "monospace",
                      fontSize: "1.35rem",
                      userSelect: "all",
                      p: 1.5,
                      borderRadius: 1,
                      bgcolor: "action.hover",
                      wordBreak: "break-all",
                    }}
                  >
                    {invited.temporaryPassword}
                  </Typography>
                </Box>
                <Typography variant="body2" color="text.secondary">
                  Entréguesela en persona o por donde usted ya se comunica con
                  ella. No se envía ningún correo: esta aplicación no manda
                  correos.
                </Typography>
              </>
            ) : (
              /* An address that already had an account keeps the password it
                 already has; the server mints nothing and says nothing, and
                 inventing reassurance here would be the same lie in a nicer
                 tone. */
              <Alert severity="info">
                Esa persona ya tenía una cuenta, así que entra con la contraseña
                que ya usaba. No se generó ninguna nueva.
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="contained" onClick={finish}>
            Ya la apunté
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

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
              "No se manda ningún correo: al terminar verá aquí una contraseña " +
                "temporal para entregársela."
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
