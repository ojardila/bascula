/**
 * The super-admin console: list farms, create one, suspend one.
 *
 * Public signup is still open. This is the operator door: provision a farm
 * with an owner who can log in, without asking them to fill the registration
 * form. The console still does not read employees, work or money of any farm
 * — every column here is a column of `farms`.
 *
 * Suspending is not deleting and the copy says so: login still works, reading
 * still works, writing answers 403, and nothing is archived or lost.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, AppBar, Avatar, Box, Button, Chip, Container, Dialog, DialogActions,
  DialogContent, DialogTitle, Stack, TextField, Toolbar, Typography,
} from "@mui/material";
import { ModuleList, type Column, type StatusFilter } from "../../components/ModuleList";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { messageFor } from "../../api/errors";
import { formatDate } from "../../lib/dates";
import { farmDevUrl, farmProdUrl, isFarmSlug } from "../../lib/farmHost";
import { parseMoneyInput } from "../../lib/money";
import { useWriteOnce } from "../../lib/writeOnce";
import { GREEN_DARK } from "../../theme";
import type { AdminFarm, AdminFarmCreated, FarmStatus } from "../../api/types";

/** No "en prueba": there is no trial anywhere in this API. */
const STATUS_LABEL: Record<FarmStatus, string> = {
  active: "Activa",
  suspended: "Suspendida",
};

export function SuperAdminPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [confirm, setConfirm] = useState<AdminFarm | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<AdminFarmCreated | null>(null);
  const [error, setActionError] = useState<string | null>(null);

  const { data, error: loadError, reload } = useAsync(
    () => api.adminListFarms({ q: search || undefined }),
    [search],
  );

  const rows = useMemo(() => {
    if (!data) return null;
    if (status === "all") return data;
    if (status === "inactive") return data.filter((f) => f.status === "suspended");
    return data.filter((f) => f.status !== "suspended");
  }, [data, status]);

  const columns: Column<AdminFarm>[] = [
    {
      key: "name",
      header: "Finca",
      // The owner's address used to sit under the name. It cannot: the console
      // may not read a farm's users at all — every column the API returns here
      // is a column of `farms`, and that projection IS the enforcement of what
      // a platform administrator is allowed to know. Where the farm is, it may
      // know; who runs it, it may not.
      render: (f) => (
        <Stack>
          <Typography sx={{ fontWeight: 600 }}>{f.name}</Typography>
          {f.slug && (
            <Typography variant="caption" color="text.secondary">
              {f.slug}.bascula.engp.io
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary">
            {[f.city, f.country].filter(Boolean).join(", ") || "—"}
          </Typography>
        </Stack>
      ),
    },
    {
      key: "status",
      header: "Estado",
      render: (f) => (
        <Chip
          size="small"
          label={STATUS_LABEL[f.status]}
          color={f.status === "suspended" ? "error" : "success"}
          variant={f.status === "active" ? "filled" : "outlined"}
        />
      ),
    },
    // Two columns went the same way as the owner's address: counting a farm's
    // employees would mean reading them, and nothing records a last access.
    // Both now come back null, and a column of dashes is worse than no column.
    {
      key: "created",
      header: "Creada",
      render: (f) => formatDate(f.createdAt.slice(0, 10)),
      secondary: true,
    },
  ];

  return (
    <Box sx={{ minHeight: "100dvh", bgcolor: "background.default" }}>
      <AppBar position="static" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Toolbar sx={{ gap: 2 }}>
          <Typography sx={{ fontWeight: 800, color: GREEN_DARK, fontSize: 20 }}>BÁSCULA</Typography>
          <Chip size="small" label="Consola de soporte" />
          <Box sx={{ flex: 1 }} />
          <Typography variant="body2" color="text.secondary">
            {user?.email}
          </Typography>
          <Avatar sx={{ width: 30, height: 30, bgcolor: GREEN_DARK, fontSize: 13 }}>
            {user?.name?.[0]}
          </Avatar>
          {user?.farm && (
            <Button color="inherit" onClick={() => navigate("/cosecha")}>
              Ir a la finca
            </Button>
          )}
          <Button
            color="inherit"
            onClick={async () => {
              await logout();
              navigate("/entrar");
            }}
          >
            Salir
          </Button>
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Cree una finca con su dueño, o suspéndala. Esta consola <strong>no lee</strong>{" "}
          empleados, labores ni dinero de ninguna de ellas.
        </Typography>

        <ModuleList<AdminFarm>
          title="Fincas"
          singular="finca"
          plural="fincas"
          rows={rows}
          error={loadError ?? error}
          columns={columns}
          getId={(f) => f.id}
          getName={(f) => f.name}
          isInactive={(f) => f.status === "suspended"}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Buscar por nombre"
          statusFilter={status}
          onStatusFilterChange={setStatus}
          onCreate={() => setCreating(true)}
          createLabel="Nueva finca"
          extraActions={(f) =>
            f.status === "suspended"
              ? [
                  {
                    label: "Reactivar",
                    onClick: async () => {
                      try {
                        await api.adminSetFarmStatus(f.id, "active");
                        reload();
                      } catch (e) {
                        setActionError(messageFor(e));
                      }
                    },
                  },
                ]
              : [{ label: "Suspender", onClick: () => setConfirm(f) }]
          }
          footer={
            rows
              ? `${rows.length} fincas · ${rows.filter((f) => f.status === "suspended").length} suspendidas`
              : null
          }
        />
      </Container>

      <ConfirmDialog
        open={!!confirm}
        title={`¿Suspender ${confirm?.name}?`}
        body="Sus usuarios seguirán pudiendo entrar y consultar, pero no podrán registrar ni modificar nada. No se borra ni se archiva ningún dato, y se puede reactivar en cualquier momento."
        confirmLabel="Suspender"
        destructive
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (!confirm) return;
          try {
            await api.adminSetFarmStatus(confirm.id, "suspended");
            setConfirm(null);
            reload();
          } catch (e) {
            setActionError(messageFor(e));
            setConfirm(null);
          }
        }}
      />

      <CreateFarmDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(farm) => {
          setCreating(false);
          setCreated(farm);
          reload();
        }}
      />

      <Dialog open={!!created} onClose={() => setCreated(null)} fullWidth maxWidth="sm">
        <DialogTitle>Finca creada</DialogTitle>
        <DialogContent>
          <Typography sx={{ mb: 1 }}>
            <strong>{created?.name}</strong> ya está activa. El dueño entra con{" "}
            <strong>{created?.ownerEmail}</strong>.
          </Typography>
          {created?.slug && (
            <Typography sx={{ mb: 1 }}>
              Dirección: <strong>{farmProdUrl(created.slug)}</strong>
              <Typography component="span" color="text.secondary" sx={{ display: "block" }}>
                En desarrollo: {farmDevUrl(created.slug)}
              </Typography>
            </Typography>
          )}
          {created?.temporaryPassword ? (
            <Alert severity="warning">
              Esta clave se muestra una sola vez. Entréguesela ahora: no se puede volver a leer.
              <Typography sx={{ fontFamily: "ui-monospace, monospace", mt: 1, fontWeight: 700 }}>
                {created.temporaryPassword}
              </Typography>
            </Alert>
          ) : created?.ownerCreated ? (
            <Typography color="text.secondary">
              El dueño entra con la clave que usted escribió.
            </Typography>
          ) : (
            <Typography color="text.secondary">
              Esa cuenta ya existía: se le agregó esta finca como dueño, sin cambiarle la clave.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={() => setCreated(null)}>
            Entendido
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function CreateFarmDialog({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (farm: AdminFarmCreated) => void;
}) {
  const { busy, run: runOnce } = useWriteOnce();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [price, setPrice] = useState("");
  const [email, setEmail] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const priceCents = parseMoneyInput(price) ?? 0;
    const slugValue = slug.trim().toLowerCase();
    if (!name.trim()) {
      setError("Escriba el nombre de la finca.");
      return;
    }
    if (!slugValue) {
      setError("Escriba el identificador de la finca.");
      return;
    }
    if (!isFarmSlug(slugValue)) {
      setError("Use letras minúsculas, números y guiones. Palabras como www o admin no se pueden usar.");
      return;
    }
    if (priceCents <= 0) {
      setError("Escriba cuánto paga por kilo.");
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setError("Escriba el correo del dueño.");
      return;
    }
    if (password && password.length < 10) {
      setError("La clave del dueño debe tener al menos 10 caracteres.");
      return;
    }
    const intent = ["admin-farm", name.trim(), email.trim().toLowerCase()].join("|");
    const outcome = await runOnce(intent, async () =>
      api.adminCreateFarm({
        name: name.trim(),
        slug: slugValue,
        priceCents,
        owner: {
          email: email.trim(),
          name: ownerName.trim(),
          password: password || undefined,
        },
      }),
    ).catch((e: unknown) => {
      setError(messageFor(e));
      return { ran: false } as const;
    });
    if (!outcome.ran || !outcome.value) return;
    onCreated(outcome.value);
    setName("");
    setSlug("");
    setPrice("");
    setEmail("");
    setOwnerName("");
    setPassword("");
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Nueva finca</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Nombre de la finca"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
          />
          <TextField
            label="Identificador"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, ""))}
            required
            autoComplete="off"
            spellCheck={false}
            helperText={`https://${slug || "sanjose"}.bascula.engp.io — en desarrollo, ${slug || "sanjose"}.int.dev.engp.io`}
          />
          <TextField
            label="Precio por kilo"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            helperText="En pesos. Es el precio de la recolección."
            required
          />
          <TextField
            label="Correo del dueño"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            required
          />
          <TextField
            label="Nombre del dueño"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
          />
          <TextField
            label="Clave del dueño"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            helperText="Opcional. Si la deja en blanco, se genera una y se muestra una sola vez."
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button variant="contained" onClick={() => void submit()} disabled={busy}>
          Crear finca
        </Button>
      </DialogActions>
    </Dialog>
  );
}
