// SPDX-License-Identifier: MIT
/**
 * Pieces of «Registro de recolección masivo» (`RegistroMasivoPage`), split
 * out so the page reads in the order of the screen: header, day, notices,
 * one row per employee, and the save bar.
 */
import type { ReactNode, Ref } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import SaveIcon from "@mui/icons-material/Save";
import type { Worker } from "../../api/types";
import { addDays, formatWeekRange, parseDay } from "../../lib/dates";
import { formatQuantity } from "../../lib/money";
import { DAY_LETTERS } from "./planilla";
import { isTeam, teamLine } from "../teams/team";
import { BasketTile } from "../workers/Basket";
import { soFarLabel, type BulkEntry, type DaySoFar } from "./bulk";

const DAY_NAMES = [
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
  "Domingo",
] as const;
const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

export const iso = (d: Date) => d.toISOString().slice(0, 10);

/** «Hoy, viernes 26 de septiembre» · «Ayer, …» · «Martes 22 de septiembre». */
export function dayTitle(day: string, today: string): string {
  const d = parseDay(day);
  const name = DAY_NAMES[(d.getUTCDay() + 6) % 7];
  const rest = `${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`;
  if (day === today) return `Hoy, ${name.toLowerCase()} ${rest}`;
  if (day === iso(addDays(parseDay(today), -1)))
    return `Ayer, ${name.toLowerCase()} ${rest}`;
  return `${name} ${rest}`;
}

export const pesadas = (n: number) =>
  n === 1 ? "1 pesada nueva" : `${n} pesadas nuevas`;

export function RegistroHeader({
  canGoBack,
  canCorrect,
}: Readonly<{ canGoBack: boolean; canCorrect: boolean }>) {
  return (
    <>
      {canGoBack && (
        <Button
          component={RouterLink}
          to="/cosecha"
          startIcon={<ArrowBackIcon />}
          sx={{ mb: 1, fontSize: "1rem" }}
        >
          Volver a la cosecha
        </Button>
      )}
      <Typography variant="h1" gutterBottom>
        Registro de recolección masivo
      </Typography>
      <Typography
        sx={{
          color: "text.secondary",
          mb: 2,
          fontSize: "1.1rem",
        }}
      >
        Las pesadas de todos los empleados en un día. Elija el día y el lote, y
        escriba los kilos de cada persona. Cada número es una pesada nueva. Si
        no pesó, déjelo en blanco.
        {canCorrect &&
          " Para cambiar una pesada ya registrada, toque «Corregir»."}
      </Typography>
    </>
  );
}

/** 1. The day — first and biggest. */
export function DayPicker({
  week,
  day,
  today,
  busy,
  setDay,
}: Readonly<{
  week: string[];
  day: string;
  today: string;
  busy: boolean;
  setDay: (d: string) => void;
}>) {
  const prevMonday = iso(addDays(parseDay(week[0]), -7));
  const nextMonday = iso(addDays(parseDay(week[0]), 7));
  return (
    <Paper
      variant="outlined"
      sx={{ p: { xs: 1.5, sm: 2 }, mb: 2, borderRadius: 3 }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          mb: 1,
        }}
      >
        <Typography
          sx={{ fontSize: "1rem", fontWeight: 600, color: "text.secondary" }}
        >
          Día
        </Typography>
        <Box sx={{ flex: 1 }} />
        <IconButton
          aria-label="Semana anterior"
          onClick={() => setDay(prevMonday)}
          size="small"
          disabled={busy}
        >
          <ChevronLeftIcon />
        </IconButton>
        <Typography
          sx={{
            fontSize: "0.95rem",
            color: "text.secondary",
            minWidth: 96,
            textAlign: "center",
          }}
        >
          {formatWeekRange(week[0])}
        </Typography>
        <IconButton
          aria-label="Semana siguiente"
          onClick={() => setDay(nextMonday)}
          disabled={busy || nextMonday > today}
          size="small"
        >
          <ChevronRightIcon />
        </IconButton>
      </Stack>
      <ToggleButtonGroup
        exclusive
        value={day}
        onChange={(_, v: string | null) => v && setDay(v)}
        aria-label="Día"
        disabled={busy}
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          width: "100%",
        }}
      >
        {week.map((d, i) => (
          <ToggleButton
            key={d}
            value={d}
            disabled={busy || d > today}
            aria-label={dayTitle(d, today)}
            sx={{
              flexDirection: "column",
              py: 1,
              px: 0,
              lineHeight: 1.2,
              "&.Mui-selected": {
                bgcolor: "primary.main",
                color: "#fff",
                "&:hover": { bgcolor: "primary.dark" },
              },
            }}
          >
            <Box component="span" sx={{ fontWeight: 700, fontSize: "1rem" }}>
              {DAY_LETTERS[i]}
            </Box>
            <Box component="span" sx={{ fontSize: "1.1rem" }}>
              {parseDay(d).getUTCDate()}
            </Box>
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <Stack
        direction="row"
        spacing={1.5}
        useFlexGap
        sx={{
          alignItems: "center",
          mt: 1.5,
          flexWrap: "wrap",
        }}
      >
        <Typography
          variant="h2"
          component="p"
          sx={{ flex: 1, minWidth: 200 }}
        >
          {dayTitle(day, today)}
        </Typography>
        {day !== today && (
          <Button
            variant="outlined"
            onClick={() => setDay(today)}
            disabled={busy}
          >
            Ir a hoy
          </Button>
        )}
      </Stack>
    </Paper>
  );
}

/** What a settled week, whole or in part, still lets anybody change. */
export function WeekNotices({
  weekSettled,
  settledCount,
}: Readonly<{ weekSettled: boolean; settledCount: number }>) {
  return (
    <>
      {weekSettled && (
        <Alert severity="warning" sx={{ mb: 2, fontSize: "1.15rem" }}>
          <strong>Esta semana ya se liquidó, no se puede cambiar.</strong> Los
          kilos de una semana liquidada quedan como se pagaron. Puede ver lo
          registrado, pero no agregar ni corregir.
        </Alert>
      )}
      {!weekSettled && settledCount > 0 && (
        <Alert severity="info" sx={{ mb: 2, fontSize: "1.05rem" }}>
          {settledCount === 1
            ? "A 1 persona ya se le liquidó esta semana: sus kilos no se pueden cambiar."
            : `A ${settledCount} personas ya se les liquidó esta semana: sus kilos no se pueden cambiar.`}
        </Alert>
      )}
    </>
  );
}

/** What the last save added, to say it plainly afterwards. */
export interface Added {
  day: string;
  plotName: string;
  entries: BulkEntry[];
}

export function AddedAlert({
  added,
  today,
  onClose,
}: Readonly<{ added: Added; today: string; onClose: () => void }>) {
  return (
    <Alert
      severity="success"
      sx={{ mb: 2, fontSize: "1.1rem" }}
      onClose={onClose}
    >
      <strong>Listo.</strong>{" "}
      {added.entries.length === 1
        ? "Se agregó 1 pesada nueva"
        : `Se agregaron ${added.entries.length} pesadas nuevas`}{" "}
      · {dayTitle(added.day, today)} · {added.plotName}:
      <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 3 }}>
        {added.entries.map((e) => (
          <li key={e.workerId}>
            {e.name}: <strong>{formatQuantity(e.quantity)} kg</strong>
          </li>
        ))}
      </Box>
    </Alert>
  );
}

export interface WorkerKilosRowProps {
  w: Worker;
  name: string;
  has: DaySoFar | undefined;
  isLocked: boolean;
  weekSettled: boolean;
  canCorrect: boolean;
  busy: boolean;
  online: boolean;
  text: string;
  onTextChange: (text: string) => void;
  onKilosFocus: () => void;
  onEnterSave: () => void;
  onNameClick: () => void;
  onCorrect: () => void;
  inputRef: Ref<HTMLInputElement>;
}

/** One employee: what they have on the day, and a box to add one more. */
export function WorkerKilosRow({
  w,
  name,
  has,
  isLocked,
  weekSettled,
  canCorrect,
  busy,
  online,
  text,
  onTextChange,
  onKilosFocus,
  onEnterSave,
  onNameClick,
  onCorrect,
  inputRef,
}: Readonly<WorkerKilosRowProps>) {
  return (
    <Card variant="outlined">
      <CardContent
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          py: 1.25,
          "&:last-child": { pb: 1.25 },
        }}
      >
        <BasketTile tag={w.tag} team={isTeam(w)} size={48} />
        <Box
          sx={{ flex: 1, minWidth: 0, cursor: "pointer" }}
          onClick={onNameClick}
        >
          <Typography sx={{ fontWeight: 600, fontSize: "1.1rem" }}>
            {name}
          </Typography>
          {isTeam(w) && (
            <Typography
              sx={{
                fontSize: "0.95rem",
                fontWeight: 600,
                color: "success.dark",
              }}
            >
              {teamLine(w)}
            </Typography>
          )}
          <Typography
            sx={{ fontSize: "0.95rem", color: "text.secondary" }}
          >
            {has ? (
              <>
                Ya tiene:{" "}
                <strong>{soFarLabel(has, formatQuantity)}</strong>
                <Box
                  component="span"
                  sx={{ display: { xs: "none", sm: "inline" } }}
                >
                  {" "}
                  (
                  {has.records
                    .map((r) =>
                      `${formatQuantity(r.quantity)} kg ${r.plotNames.join(", ")}`.trim(),
                    )
                    .join(" · ")}
                  )
                </Box>
              </>
            ) : (
              "Sin pesadas este día"
            )}
          </Typography>
          {isLocked && !weekSettled && (
            <Typography
              sx={{
                fontSize: "0.95rem",
                fontWeight: 600,
                color: "warning.dark",
              }}
            >
              Semana liquidada: no se puede cambiar
            </Typography>
          )}
          {has && canCorrect && !isLocked && (
            <Button
              size="small"
              variant="outlined"
              disabled={busy || !online}
              onClick={(e) => {
                e.stopPropagation();
                onCorrect();
              }}
              aria-label={`Corregir las pesadas de ${name}`}
              sx={{ mt: 0.75, minHeight: 40, fontSize: "1rem" }}
            >
              Corregir
            </Button>
          )}
        </Box>
        <TextField
          value={text}
          placeholder="+"
          onChange={(e) => onTextChange(e.target.value)}
          onFocus={onKilosFocus}
          onKeyDown={(e) => {
            // Enter with kilos written asks to save: type, Enter, «Sí, guardar».
            if (
              e.key === "Enter" &&
              text.trim() !== ""
            ) {
              e.preventDefault();
              onEnterSave();
            }
          }}
          disabled={busy || isLocked}
          inputRef={inputRef}
          sx={{
            width: { xs: 128, sm: 150 },
            flexShrink: 0,
            "& input": {
              textAlign: "right",
              fontSize: 26,
              fontWeight: 600,
              py: 1.5,
            },
          }}
          slotProps={{
            input: {
              endAdornment: (
                <Typography
                  sx={{ ml: 0.5, color: "text.secondary" }}
                >
                  kg
                </Typography>
              ),
            },
            htmlInput: {
              inputMode: "decimal",
              enterKeyHint: "done",
              "aria-label": `${name}, kilos`,
            },
          }}
        />
      </CardContent>
    </Card>
  );
}

/** 3. One row per employee, or why there are none yet. */
export function WorkerList({
  plotId,
  loaded,
  workers,
  shown,
  searching,
  clearSearch,
  renderRow,
  dayKilos,
  entriesCount,
  newKilos,
}: Readonly<{
  plotId: string;
  loaded: boolean;
  workers: Worker[];
  shown: Worker[];
  searching: boolean;
  clearSearch: () => void;
  renderRow: (w: Worker) => ReactNode;
  dayKilos: number;
  entriesCount: number;
  newKilos: number;
}>) {
  if (!plotId) return <Alert severity="info">Elija el lote.</Alert>;
  if (!loaded) {
    return (
      <Stack
        sx={{
          alignItems: "center",
          py: 6,
        }}
      >
        <CircularProgress />
      </Stack>
    );
  }
  if (workers.length === 0) {
    return (
      <Alert severity="info">
        No hay empleados activos. Regístrelos primero en Empleados.
      </Alert>
    );
  }
  return (
    // While searching on a phone, keep room below so the search can stay
    // at the top of the screen with the matches right under it.
    <Box sx={{ minHeight: searching ? { xs: "80vh", sm: 0 } : undefined }}>
      {searching && shown.length > 0 && (
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: "center",
            mb: 1,
          }}
        >
          <Typography
            sx={{
              color: "text.secondary",
              flex: 1,
              fontSize: "1.05rem",
            }}
          >
            {shown.length === 1 ? "1 persona" : `${shown.length} personas`}{" "}
            de {workers.length}
          </Typography>
          <Button onClick={clearSearch} sx={{ fontSize: "1rem" }}>
            Ver a todos
          </Button>
        </Stack>
      )}
      {searching && shown.length === 0 && (
        <Alert
          severity="info"
          sx={{ fontSize: "1.1rem", alignItems: "center" }}
          action={
            <Button onClick={clearSearch} sx={{ fontSize: "1rem" }}>
              Ver a todos
            </Button>
          }
        >
          No hay nadie con ese nombre o canasto
        </Alert>
      )}
      <Stack spacing={1.25}>
        {shown.map(renderRow)}
      </Stack>
      <Typography sx={{ mt: 2, fontSize: "1.15rem" }}>
        Registrado este día: <strong>{formatQuantity(dayKilos)} kg</strong>
        {entriesCount > 0 && (
          <>
            {" "}
            · por agregar: <strong>{formatQuantity(newKilos)} kg</strong>
          </>
        )}
      </Typography>
    </Box>
  );
}

/** 4. Save. Stuck to the bottom only while there is something to save. */
export function SaveBar({
  dirty,
  count,
  busy,
  onSave,
}: Readonly<{
  dirty: boolean;
  count: number;
  busy: boolean;
  onSave: () => void;
}>) {
  return (
    <Paper
      elevation={dirty ? 6 : 0}
      variant={dirty ? "elevation" : "outlined"}
      sx={{
        position: dirty ? "sticky" : "static",
        bottom: 12,
        mt: 3,
        p: 1.5,
        borderRadius: 3,
        display: "flex",
        alignItems: "center",
        gap: 2,
        flexWrap: "wrap",
        zIndex: 2,
      }}
    >
      <Typography
        sx={{ flex: 1, minWidth: 160, fontSize: "1.05rem" }}
        color={dirty ? "text.primary" : "text.secondary"}
      >
        {dirty
          ? `${pesadas(count)} sin guardar`
          : "Escriba los kilos para agregar pesadas"}
      </Typography>
      <Button
        variant="contained"
        size="large"
        startIcon={<SaveIcon />}
        onClick={onSave}
        disabled={busy || !dirty}
        sx={{
          minHeight: 56,
          px: 4,
          fontSize: "1.15rem",
          borderRadius: 3,
          flexGrow: { xs: 1, sm: 0 },
        }}
      >
        Guardar
      </Button>
    </Paper>
  );
}
