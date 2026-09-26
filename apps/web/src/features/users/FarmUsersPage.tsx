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
 * ── TWO SECTIONS: OWNERS, AND EVERYBODY ELSE ───────────────────────────
 *
 * Many farms have more than one owner — siblings, spouses, partners — and the
 * server always allowed an owner to invite another (`mayGrant`: nobody grants
 * a role above their own). The screen did not offer it. The approved
 * onboarding design (Sept 2026) adds it, but never mixed with inviting a
 * weigher: its own section «Dueños de la finca», its own button, a warning
 * that an owner can do everything, a confirmation checkbox, and a button that
 * names the role. Tour step 3 points at that section; steps 4–7 at the rest.
 *
 * ── THE SERVER SERVES THIS NOW ─────────────────────────────────────────
 *
 * The refusal path below is kept as a floor for an older server, and the two
 * rules it was built on still hold:
 *
 *   IT NEVER SHOWS AN EMPTY LIST. An empty table under "Usuarios de la finca"
 *   says this farm has nobody in it, which is false of every farm — somebody
 *   is logged in reading it. So a missing route produces a named refusal,
 *   with the routes it is waiting for, and no table at all.
 *
 *   IT NEVER PRETENDS A WRITE WORKED. The invite form posts and reports what
 *   came back. There is no optimistic row, because a row that appears and
 *   vanishes on reload is worse than a refusal.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, AlertTitle, Box, Button, Card, CardContent, Checkbox, Chip, Dialog, DialogActions,
  DialogContent, DialogTitle, FormControlLabel, MenuItem, Radio, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, TextField, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import AddIcon from "@mui/icons-material/Add";
import KeyIcon from "@mui/icons-material/Key";
import { PermissionDenied } from "../../components/Guards";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useAsync } from "../../lib/useAsync";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { formatDate } from "../../lib/dates";
import { useWriteOnce } from "../../lib/writeOnce";
import type { FarmUser, FarmUserStatus, Role } from "../../api/types";
import { useTour, useTourAction } from "../onboarding/TourContext";
import { TourCallout } from "../onboarding/TourCallout";

/**
 * The two roles the ordinary invitation hands out, with what each one
 * actually opens. Written out because "administrador" and "pesador" mean
 * nothing to somebody choosing between them, and the wrong choice here hands
 * the payroll to whoever is holding the scale this season.
 *
 * `owner` is not in this list on purpose: it has its own section and dialog,
 * with a warning and a confirmation, so it can never be picked by accident.
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
  const tour = useTour();
  const [inviting, setInviting] = useState(false);
  const [invitingOwner, setInvitingOwner] = useState(false);
  const [revoking, setRevoking] = useState<FarmUser | null>(null);
  // A PATCH of a role is idempotent by nature, so nothing here could ever
  // double-write. The guard keeps one answer to "can this button fire twice"
  // across the whole console rather than two.
  const { busy, run: runOnce } = useWriteOnce();
  const [actionError, setActionError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const { data, error, denied } = useAsync(() => api.listFarmUsers(), [tick]);
  const reload = () => setTick((t) => t + 1);

  // Tour step 3: the owner dialog is the person's; the tour waits for it.
  useTourAction("open-owner-invite", () => {
    setInvitingOwner(true);
    tour.pause();
    return true;
  });
  // Tour step 4: open the real invitation; step 5 lives inside it.
  useTourAction("open-invite", () => {
    setInviting(true);
    return true;
  });

  if (!can("config.users")) return <PermissionDenied moduleName="gestionar los usuarios" />;
  if (denied) return <PermissionDenied moduleName="gestionar los usuarios" />;

  const unsupported = error !== null && data === null;
  const owners = (data ?? []).filter((u) => u.role === "owner");
  const others = (data ?? []).filter((u) => u.role !== "owner");

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

  const lastLogin = (u: FarmUser) =>
    /* THREE CASES, and the third is the one that bit. `/v1/users` does not
       send a last login at all, so `undefined` means "not reported" — and
       printing that as "nunca ha entrado" told the owner he had never logged
       in while he was reading the screen. A date is a date, `null` is
       genuinely never, absent is "—". */
    u.lastLoginAt === undefined ? (
      <Typography variant="body2" color="text.secondary" title="El servidor no informa la última entrada.">
        —
      </Typography>
    ) : u.lastLoginAt === null ? (
      <Typography variant="body2" color="text.secondary">
        Nunca ha entrado
      </Typography>
    ) : (
      formatDate(u.lastLoginAt.slice(0, 10))
    );

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
          <Typography color="text.secondary" sx={{ fontSize: 17 }}>
            Quién puede entrar a {user?.farm.name} y con qué permisos.
          </Typography>
        </Box>
        <Button
          data-tour="invite"
          variant="contained"
          size="large"
          startIcon={<PersonAddIcon />}
          disabled={unsupported}
          onClick={() => setInviting(true)}
          sx={{ minHeight: 52, fontSize: 17, borderRadius: 999, px: 3 }}
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
        <>
          {/* ── Dueños de la finca ── */}
          <Card data-tour="owners" sx={{ mb: 3, borderRadius: 4, border: 2, borderColor: "#d5e8d0" }}>
            <CardContent sx={{ p: { xs: 2.25, sm: 3 } }}>
              <Stack direction="row" spacing={1.25} alignItems="center">
                <KeyIcon sx={{ color: "#c9a227", fontSize: 30 }} />
                <Typography variant="h3" component="h2" sx={{ fontSize: 22, fontWeight: 800 }}>
                  Dueños de la finca
                </Typography>
              </Stack>
              <Typography sx={{ fontSize: 16, color: "text.secondary", mt: 0.5, mb: 1.5 }}>
                Ven y cambian todo: precios, pagos y usuarios.
              </Typography>
              <Stack divider={<Box sx={{ borderTop: 1, borderColor: "divider" }} />}>
                {data === null && <Typography color="text.secondary">Cargando…</Typography>}
                {owners.map((u) => (
                  <Stack key={u.id} direction="row" alignItems="center" spacing={1.5} sx={{ py: 1.25 }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 700, fontSize: 17 }}>
                        {u.name || "—"}
                        {u.id === user?.id && (
                          <Chip size="small" variant="outlined" label="usted" sx={{ ml: 1, height: 22 }} />
                        )}
                      </Typography>
                      <Typography sx={{ fontSize: 15, color: "text.secondary", wordBreak: "break-all" }}>
                        {u.email}
                      </Typography>
                    </Box>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={STATUS_CHIP[u.status].color}
                      label={STATUS_CHIP[u.status].label}
                    />
                  </Stack>
                ))}
              </Stack>
              <Button
                fullWidth
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={() => setInvitingOwner(true)}
                sx={{ mt: 2, minHeight: 52, borderRadius: 999, fontSize: 17, fontWeight: 700, borderWidth: 2, "&:hover": { borderWidth: 2 } }}
              >
                Invitar a otro dueño
              </Button>
            </CardContent>
          </Card>

          {/* ── Administradores y pesadores ── */}
          <Card data-tour="users-list" sx={{ borderRadius: 4 }}>
            <CardContent sx={{ p: { xs: 2.25, sm: 3 }, pb: 0 }}>
              <Typography variant="h3" component="h2" sx={{ fontSize: 22, fontWeight: 800 }}>
                Administradores y pesadores
              </Typography>
              <Typography sx={{ fontSize: 16, color: "text.secondary", mt: 0.5 }}>
                Cada uno entra con su propio correo y ve solo lo que su rol le deja.
              </Typography>
            </CardContent>
            <Box sx={{ overflowX: "auto" }}>
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
                  {others.map((u) => {
                    const isMe = u.id === user?.id;
                    return (
                      <TableRow key={u.id} sx={{ opacity: u.status === "revoked" ? 0.55 : 1 }}>
                        <TableCell>
                          <Stack>
                            <Typography sx={{ fontWeight: 600 }}>
                              {u.name || "—"}
                              {isMe && <Chip size="small" label="usted" sx={{ ml: 1, height: 20 }} />}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {u.email}
                            </Typography>
                          </Stack>
                        </TableCell>
                        <TableCell>
                          {/* Your own role is not editable here: somebody who
                              has just demoted themselves cannot undo it. The
                              server enforces it too. */}
                          {isMe ? (
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
                        <TableCell>{lastLogin(u)}</TableCell>
                        <TableCell align="right">
                          {!isMe && u.status !== "revoked" && (
                            <Button size="small" color="error" disabled={busy} onClick={() => setRevoking(u)}>
                              Quitar acceso
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {data !== null && others.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} sx={{ color: "text.secondary", fontSize: 16 }}>
                        Todavía no ha invitado a nadie. Toque «Invitar a alguien».
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Box>
          </Card>
        </>
      )}

      <Card variant="outlined" sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h3" gutterBottom>
            Qué abre cada rol
          </Typography>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <Box>
              <Typography sx={{ fontWeight: 600 }}>Dueño</Typography>
              <Typography variant="body2" color="text.secondary">
                Todo, incluidos los precios, los pagos, dar de baja y la cuenta de cada
                persona. Se invita aparte, en «Dueños de la finca».
              </Typography>
            </Box>
            {ROLES.map((r) => (
              <Box key={r.value}>
                <Typography sx={{ fontWeight: 600 }}>{r.label}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {r.blurb}
                </Typography>
              </Box>
            ))}
          </Stack>
          <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
            Esconder un botón no es un permiso. El rol se aplica también en el servidor,
            porque un teléfono se presta y una sesión se comparte.
          </Alert>
        </CardContent>
      </Card>

      <InviteDialog
        open={inviting}
        onClose={() => {
          setInviting(false);
          // Closed before inviting anybody: back to the step that opens it.
          if (tour.isAt("owner", 5)) tour.goTo(4);
        }}
        /* Reloads the list but does NOT close the dialog: the invitation's
           reply carries the one and only copy of the person's password, and
           closing over it would destroy it. The dialog closes itself once the
           credential has been acknowledged. */
        onDone={reload}
      />

      <InviteDialog
        owner
        open={invitingOwner}
        onClose={() => {
          setInvitingOwner(false);
          // Tour step 3 waits for this dialog, whatever happened in it.
          if (tour.current?.tour === "owner" && tour.current.n === 3) tour.goTo(4);
        }}
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
 * The invitation — of an administrator or weigher, or (with `owner`) of
 * another owner.
 *
 * The role is chosen from two cards with their consequence written on them,
 * not from a bare dropdown of two words. This is the one form in the console
 * where picking the wrong option hands somebody the payroll.
 *
 * ── THERE IS NO EMAIL, AND THIS SCREEN USED TO PROMISE ONE ──────────────
 *
 * There is no mail sender in `services/api`; `handleInviteUser` mints a
 * password, hashes it, and returns the plaintext in the invite response ONCE.
 * So the dialog has two phases: the form, and then the credential — shown in
 * full, with the warning that this is the only time it exists, and the dialog
 * deliberately not closing on its own so it cannot be dismissed before it has
 * been written down.
 */
function InviteDialog({
  open,
  onClose,
  onDone,
  owner = false,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  owner?: boolean;
}) {
  const tour = useTour();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("weigher");
  const [confirmed, setConfirmed] = useState(false);
  const { busy, run: runOnce } = useWriteOnce();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  /** Phase two: the account exists and this is the only copy of its password. */
  const [invited, setInvited] = useState<FarmUser | null>(null);

  const reset = () => {
    setEmail("");
    setName("");
    setRole("weigher");
    setConfirmed(false);
    setError(null);
    setFields({});
    setInvited(null);
  };

  const chosenRole: Role = owner ? "owner" : role;
  const ready = email.trim() !== "" && name.trim() !== "" && (!owner || confirmed);

  async function submit(): Promise<boolean> {
    setFields({});
    if (!ready) {
      setError(
        owner && email.trim() && name.trim()
          ? "Marque la casilla para confirmar que es dueño o socio."
          : "Escriba el correo y el nombre de la persona.",
      );
      return false;
    }
    // One membership per filled-in form. The id used to be minted inside the
    // call, so a double click sent two different ids for the same person.
    // See `lib/writeOnce.ts`.
    const intent = ["invitar", email.trim().toLowerCase(), name.trim(), chosenRole].join("|");
    const outcome = await runOnce(intent, async (mint) => {
      setError(null);
      return api.inviteFarmUser({ id: mint(), email, name, role: chosenRole });
    }).catch((e: unknown) => {
      if (e instanceof ApiError) setFields(e.fieldErrors);
      setError(messageFor(e));
      return { ran: false } as const;
    });
    if (!outcome.ran) return false;
    // The list behind the dialog refreshes now; the dialog itself stays open
    // on the credential, because closing it would destroy the password.
    onDone();
    setInvited(outcome.value);
    tour.note((s) => (owner ? { owners: s.owners + 1 } : { people: s.people + 1 }));
    if (tour.isAt("owner", 5)) tour.goTo(6);
    return true;
  }

  function finish() {
    const wasStep6 = tour.isAt("owner", 6);
    reset();
    onClose();
    if (wasStep6) tour.goTo(7);
  }

  // ── PHASE TWO: the credential ──────────────────────────────────────
  if (invited) {
    const first = (invited.name || "").trim().split(/\s+/)[0];
    return (
      <Dialog open={open} onClose={finish} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontSize: 22, fontWeight: 800 }}>
          {invited.name || invited.email} ya tiene acceso
        </DialogTitle>
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
                <Box data-tour="invite-credential">
                  <Typography variant="overline" color="text.secondary">
                    Correo
                  </Typography>
                  <Typography sx={{ fontFamily: "monospace", fontSize: "1.05rem", wordBreak: "break-all" }}>
                    {invited.email}
                  </Typography>
                  <Typography variant="overline" color="text.secondary" component="div" sx={{ mt: 1 }}>
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
                  {first ? ` ${first}` : " ella"}. No se envía ningún correo: esta aplicación no manda
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
            {!owner && (
              <TourCallout
                tour="owner"
                n={6}
                onPrimary={() => {
                  finish();
                  return true;
                }}
              />
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="contained" onClick={finish} sx={{ minHeight: 48, fontSize: 17, borderRadius: 999, px: 3 }}>
            Ya la apunté
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontSize: 22, fontWeight: 800 }}>
        {owner ? "Invitar a otro dueño" : "Invitar a alguien a la finca"}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {owner && (
            <Alert severity="warning" icon={false} sx={{ fontSize: 16 }}>
              <AlertTitle sx={{ fontWeight: 800 }}>Un dueño puede todo</AlertTitle>
              Ve y cambia precios y pagos, invita o quita personas y puede borrar registros.
              Solo usted u otro dueño le pueden quitar el acceso.
            </Alert>
          )}
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
          {owner ? (
            <FormControlLabel
              sx={{
                m: 0, p: 1.25, pr: 2, borderRadius: 3, border: 2,
                borderColor: confirmed ? "primary.main" : "divider",
                bgcolor: confirmed ? "#f1f8ef" : "transparent",
                alignItems: "flex-start",
              }}
              control={<Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />}
              label={
                <Typography sx={{ fontSize: 17, pt: 1 }}>
                  Confirmo que <strong>{name.trim() || "esta persona"}</strong> es dueño o socio de
                  la finca.
                </Typography>
              }
            />
          ) : (
            <Box data-tour="invite-role" role="radiogroup" aria-label="Rol">
              <Typography sx={{ fontSize: 15, color: "text.secondary", mb: 1 }}>Rol</Typography>
              <Stack spacing={1.25}>
                {ROLES.map((r) => {
                  const on = role === r.value;
                  return (
                    <Box
                      key={r.value}
                      onClick={() => setRole(r.value)}
                      sx={{
                        display: "flex", gap: 1, alignItems: "flex-start", cursor: "pointer",
                        p: 1.25, borderRadius: 3, border: 2,
                        borderColor: on ? "primary.main" : "divider",
                        bgcolor: on ? "#f1f8ef" : "transparent",
                      }}
                    >
                      <Radio
                        checked={on}
                        onChange={() => setRole(r.value)}
                        value={r.value}
                        slotProps={{ input: { "aria-label": r.label } }}
                      />
                      <Box sx={{ pt: 0.75 }}>
                        <Typography sx={{ fontSize: 18, fontWeight: 800 }}>{r.label}</Typography>
                        <Typography sx={{ fontSize: 15, color: "text.secondary" }}>{r.blurb}</Typography>
                      </Box>
                    </Box>
                  );
                })}
              </Stack>
            </Box>
          )}
          {!owner && <TourCallout tour="owner" n={5} onPrimary={submit} />}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} color="inherit" sx={{ minHeight: 48, fontSize: 17 }}>
          Cancelar
        </Button>
        <Button
          variant="contained"
          onClick={() => void submit()}
          disabled={busy || !ready}
          sx={{ minHeight: 48, fontSize: 17, borderRadius: 999, px: 3 }}
        >
          {busy ? "Invitando…" : owner ? "Invitar como dueño" : "Enviar la invitación"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
