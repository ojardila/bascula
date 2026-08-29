/**
 * The super-admin console: list farms, suspend one, and nothing else.
 *
 * Decision 2 in `docs/decisiones.md` took the front door away from this screen
 * — farms register themselves now — and left it with exactly the two things it
 * still needs to do. It reads no employees, no work, no money of any farm, and
 * that is why it lives outside the tenant shell, on its own routes, with no
 * sidebar of modules.
 *
 * Suspending is not deleting and the copy says so: login still works, reading
 * still works, writing answers 403, and nothing is archived or lost.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AppBar, Avatar, Box, Button, Chip, Container, Stack, Toolbar, Typography,
} from "@mui/material";
import { ModuleList, type Column, type StatusFilter } from "../../components/ModuleList";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { messageFor } from "../../api/errors";
import { formatDate } from "../../lib/dates";
import { GREEN_DARK } from "../../theme";
import type { AdminFarm, FarmStatus } from "../../api/types";

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
          Esta consola ve las fincas y su estado. <strong>No lee</strong> empleados,
          labores ni dinero de ninguna de ellas, y no puede crearlas: desde el
          auto-registro, las fincas se dan de alta solas.
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
          searchPlaceholder="Buscar por nombre o correo del dueño"
          statusFilter={status}
          onStatusFilterChange={setStatus}
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
    </Box>
  );
}
