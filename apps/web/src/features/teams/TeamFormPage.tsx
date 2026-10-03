/**
 * «Nuevo equipo» / «Cambiar integrantes» (docs/use-cases/teams.md, TEAM-01..03).
 *
 * A team is one account for people who pick into one sack and get paid
 * together. Each member is still a person on the farm's list; while they are
 * in the team their kilos and money go to the team. The same screen converts
 * an old combined record («Yorman y Sergio» as one person) into a team: it
 * keeps the id, the tag, the weighings and the account.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import GroupsIcon from "@mui/icons-material/Groups";
import SearchIcon from "@mui/icons-material/Search";
import AddIcon from "@mui/icons-material/Add";
import { api } from "../../api/endpoints";
import { ApiError, duplicateTagField, messageFor } from "../../api/errors";
import { BASKET_LABEL, BASKET_REQUIRED, BasketTile } from "../workers/Basket";
import { useAuth } from "../../auth/AuthContext";
import { uuidv7 } from "../../lib/uuid";
import { useWriteOnce } from "../../lib/writeOnce";
import { formatDate, todayInFarm } from "../../lib/dates";
import { DateField } from "../../components/DateField";
import type { Worker } from "../../api/types";
import { foldName } from "../workrecords/bulk";
import { isTeam } from "./team";

const big = { fontSize: "1.15rem" } as const;

export function TeamFormPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { user } = useAuth();
  const today = todayInFarm(user?.farm?.timezone ?? "America/Bogota");
  const editing = Boolean(id);
  const [teamId] = useState(() => id ?? uuidv7());
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initial, setInitial] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState(today);
  const [wasPerson, setWasPerson] = useState(false);
  const [people, setPeople] = useState<Worker[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);
  const [hadTag, setHadTag] = useState(false);
  const [adding, setAdding] = useState(false);
  const { busy, run } = useWriteOnce();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [list, team] = await Promise.all([
        api.listWorkers({ status: "active" }),
        id ? api.getWorker(id) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setPeople(list.filter((w) => !isTeam(w) && w.id !== id));
      if (team) {
        setName(`${team.name} ${team.lastName}`.trim());
        setTag(team.tag ?? "");
        setHadTag(!!team.tag);
        setWasPerson(!isTeam(team));
        const ids = new Set((team.members ?? []).map((m) => m.id));
        setSelected(ids);
        setInitial(new Set(ids));
        // A combined record being converted: its people start the day the
        // record's first weighings were made, which only the user knows.
        // Default to today; the user moves it back.
      }
    };
    load().catch((e) => !cancelled && setError(messageFor(e)));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const shown = useMemo(() => {
    const words = foldName(search).split(" ").filter(Boolean);
    return (people ?? []).filter((p) => {
      const text = foldName(`${p.name} ${p.lastName} ${p.tag ?? ""}`);
      return words.every((w) => text.includes(w));
    });
  }, [people, search]);

  const changed =
    selected.size !== initial.size ||
    [...selected].some((x) => !initial.has(x));
  const n = selected.size;

  function toggle(pid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    const missingName = !name.trim();
    const missingTag = !tag.trim() && (!editing || hadTag);
    setNameError(missingName ? "Escriba el nombre del equipo." : null);
    setTagError(missingTag ? BASKET_REQUIRED : null);
    if (missingName || missingTag) return;
    const memberIds = [...selected];
    const outcome = await run(
      `equipo|${teamId}|${memberIds.join(",")}|${from}`,
      async () => {
        if (!editing) {
          return api.createWorker({
            id: teamId,
            name: name.trim(),
            lastName: "",
            documentType: "CC",
            documentNumber: "",
            phone: "",
            tag: tag.trim() || null,
            kind: "equipo",
            memberIds,
            membersFrom: from,
          });
        }
        if (wasPerson) await api.updateWorker(teamId, { kind: "equipo" });
        return api.updateWorker(teamId, {
          name: name.trim(),
          lastName: "",
          ...(tag.trim() || hadTag ? { tag: tag.trim() } : {}),
          ...(changed || wasPerson ? { memberIds, membersFrom: from } : {}),
        });
      },
    ).catch((e: unknown) => {
      if (e instanceof ApiError && e.code === "DUPLICATE_TAG")
        setTagError(duplicateTagField(e));
      else setError(messageFor(e));
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    navigate(`/empleados/${outcome.value.id}`, { replace: true });
  }

  const title = !editing
    ? "Nuevo equipo"
    : wasPerson
      ? "Convertir en equipo"
      : "Cambiar integrantes";

  return (
    <Box component="form" onSubmit={onSubmit} noValidate sx={{ maxWidth: 640 }}>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() =>
          navigate(editing ? `/empleados/${teamId}` : "/empleados")
        }
        color="inherit"
        sx={{ mb: 1 }}
      >
        {editing ? "Volver" : "Empleados"}
      </Button>
      <Typography variant="h1" gutterBottom>
        {title}
      </Typography>
      <Typography
        sx={{
          color: "text.secondary",
          ...big,
          mb: 2,
        }}
      >
        Para quienes recogen juntos y cobran juntos.
      </Typography>
      {wasPerson && (
        <Alert severity="info" sx={{ mb: 2, ...big }}>
          Se queda con sus pesadas, su número de canasto y su cuenta. Marque
          quiénes son las personas y desde qué día trabajan juntas.
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2, ...big }}>
          {error}
        </Alert>
      )}

      <Stack spacing={2.5}>
        <TextField
          label="Nombre del equipo"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={!!nameError}
          helperText={nameError ?? "Por ejemplo: Yorman y Sergio"}
          required
          autoFocus={!editing}
          sx={{ "& input": big }}
        />
        <TextField
          label={BASKET_LABEL}
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          error={!!tagError}
          helperText={
            tagError ??
            (editing && !hadTag
              ? "Este equipo todavía no tiene número de canasto. Escríbalo aquí."
              : "El equipo tiene su propio número, por ejemplo 46-63. Cada persona conserva el suyo.")
          }
          required={!editing || hadTag}
          slotProps={{ htmlInput: { autoCapitalize: "characters" } }}
          sx={{
            maxWidth: 360,
            "& input": { fontSize: "2rem", fontWeight: 800, py: 1.5 },
            "& .MuiFormHelperText-root": { fontSize: "0.95rem" },
          }}
        />

        <Box>
          <Typography variant="h2" sx={{ fontSize: "1.4rem", fontWeight: 700 }}>
            ¿Quiénes son?
          </Typography>
          <Typography
            sx={[
              {
                color: "text.secondary",
              },
              ...(Array.isArray(big) ? big : [big]),
            ]}
          >
            Marque las personas del equipo. Cada una sigue siendo un trabajador.
          </Typography>
        </Box>
        <Card variant="outlined">
          <CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
            <TextField
              placeholder="Buscar trabajador"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              fullWidth
              sx={{ mb: 1, "& input": big }}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon />
                    </InputAdornment>
                  ),
                },
              }}
            />
            {people === null ? (
              <Typography
                sx={{
                  color: "text.secondary",
                  p: 2,
                }}
              >
                Cargando…
              </Typography>
            ) : (
              <List disablePadding sx={{ maxHeight: 420, overflowY: "auto" }}>
                {shown.map((p) => {
                  const other = p.team && p.team.id !== teamId ? p.team : null;
                  const label = `${p.name} ${p.lastName}`.trim();
                  return (
                    <ListItemButton
                      key={p.id}
                      divider
                      disabled={!!other}
                      onClick={() => toggle(p.id)}
                      sx={{ py: 1.25 }}
                    >
                      <ListItemIcon sx={{ minWidth: 44 }}>
                        <Checkbox
                          edge="start"
                          checked={selected.has(p.id)}
                          tabIndex={-1}
                          sx={{ "& .MuiSvgIcon-root": { fontSize: 30 } }}
                          slotProps={{
                            input: { "aria-label": label },
                          }}
                        />
                      </ListItemIcon>
                      <BasketTile tag={p.tag} size={44} sx={{ mr: 1.5 }} />
                      <ListItemText
                        primary={label}
                        secondary={
                          other
                            ? `Ya está en el equipo ${other.name}`
                            : p.tag
                              ? `Canasto ${p.tag}`
                              : "Sin canasto"
                        }
                        slotProps={{
                          primary: {
                            sx: { fontWeight: 700, fontSize: "1.1rem" },
                          },
                          secondary: { sx: { fontSize: "0.95rem" } },
                        }}
                      />
                    </ListItemButton>
                  );
                })}
                {shown.length === 0 && (
                  <Typography
                    sx={{
                      color: "text.secondary",
                      p: 2,
                      ...big,
                    }}
                  >
                    No hay nadie con ese nombre.
                  </Typography>
                )}
              </List>
            )}
            <Button
              startIcon={<AddIcon />}
              onClick={() => setAdding(true)}
              sx={{ mt: 1, fontSize: "1.05rem" }}
            >
              Agregar una persona nueva
            </Button>
          </CardContent>
        </Card>

        {(!editing || changed || wasPerson) && (
          <DateField
            label={
              editing
                ? "¿Desde qué día cuenta este cambio?"
                : "¿Desde qué día trabajan juntos?"
            }
            value={from}
            onChange={setFrom}
          />
        )}

        <Alert icon={<GroupsIcon />} severity="success" sx={big}>
          <strong>{n === 1 ? "1 persona." : `${n} personas.`}</strong> Las
          pesadas, la liquidación y los pagos van a{" "}
          <strong>nombre del equipo</strong>.
          {n > 1 && ` Para los promedios, los kilos se dividen entre ${n}.`}
          {editing &&
            changed &&
            from &&
            ` El cambio cuenta desde el ${formatDate(from)}.`}
        </Alert>

        <Button
          type="submit"
          variant="contained"
          size="large"
          disabled={busy}
          sx={{ minHeight: 56, fontSize: "1.2rem" }}
        >
          {busy ? "Guardando…" : "Guardar equipo"}
        </Button>
        <Button
          color="inherit"
          onClick={() =>
            navigate(editing ? `/empleados/${teamId}` : "/empleados")
          }
          sx={big}
        >
          Cancelar
        </Button>
      </Stack>

      {adding && (
        <NewPersonDialog
          onClose={() => setAdding(false)}
          onCreated={(w) => {
            setPeople((prev) => [...(prev ?? []), w]);
            setSelected((prev) => new Set(prev).add(w.id));
            setAdding(false);
          }}
        />
      )}
    </Box>
  );
}

/** The quickest way to put a member on the list: a name and their basket number. */
function NewPersonDialog({
  onClose,
  onCreated,
}: Readonly<{
  onClose: () => void;
  onCreated: (w: Worker) => void;
}>) {
  const [workerId] = useState(() => uuidv7());
  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [tag, setTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);
  const { busy, run } = useWriteOnce();

  async function save() {
    if (!name.trim()) {
      setError("Escriba el nombre.");
      return;
    }
    if (!tag.trim()) {
      setTagError(BASKET_REQUIRED);
      return;
    }
    setTagError(null);
    const outcome = await run(`persona|${workerId}`, () =>
      api.createWorker({
        id: workerId,
        name: name.trim(),
        lastName: lastName.trim(),
        documentType: "CC",
        documentNumber: "",
        phone: "",
        tag: tag.trim(),
      }),
    ).catch((e: unknown) => {
      if (e instanceof ApiError && e.code === "DUPLICATE_TAG")
        setTagError(duplicateTagField(e));
      else setError(messageFor(e));
      return { ran: false } as const;
    });
    if (outcome.ran) onCreated(outcome.value);
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Persona nueva</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Nombres"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
            sx={{ "& input": big }}
          />
          <TextField
            label="Apellidos (opcional)"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            sx={{ "& input": big }}
          />
          <TextField
            label={BASKET_LABEL}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            error={!!tagError}
            helperText={tagError ?? "El número de su propio canasto."}
            required
            sx={{ "& input": { fontSize: "1.6rem", fontWeight: 800 } }}
          />
          <Typography
            sx={{
              color: "text.secondary",
            }}
          >
            La cédula y el teléfono se pueden completar después en su ficha.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy}>
          Agregar
        </Button>
      </DialogActions>
    </Dialog>
  );
}
