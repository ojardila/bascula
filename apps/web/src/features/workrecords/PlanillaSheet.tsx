// SPDX-License-Identifier: MIT
/**
 * The body of the harvest sheet (`PlanillaPage`): the day list, the week
 * grid, and the states before either can be drawn.
 */
import {
  Alert,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import type { Worker } from "../../api/types";
import { formatDate, parseDay } from "../../lib/dates";
import {
  DAY_LETTERS,
  cellKey,
  emptyCell,
  workerLabel,
  type SheetCell,
} from "./planilla";

export function dayHeader(day: string, i: number): string {
  const d = parseDay(day);
  return `${DAY_LETTERS[i]} ${d.getUTCDate()}`;
}

interface GridProps {
  workers: Worker[];
  cells: Record<string, SheetCell>;
  setCell: (workerId: string, day: string, text: string) => void;
  today: string;
  busy: boolean;
}

function DayList({
  workers,
  cells,
  setCell,
  today,
  busy,
  day,
}: Readonly<GridProps & { day: string }>) {
  return (
    <Stack spacing={1.5}>
      {workers.map((w) => {
        const cell = cells[cellKey(w.id, day)] ?? emptyCell();
        const future = day > today;
        return (
          <Stack
            key={w.id}
            direction="row"
            spacing={2}
            sx={{
              alignItems: "center",
            }}
          >
            <Typography
              sx={{ flex: 1, fontWeight: 600, minWidth: 0 }}
            >
              {workerLabel(w)}
            </Typography>
            <TextField
              value={cell.text}
              onChange={(e) => setCell(w.id, day, e.target.value)}
              disabled={
                busy ||
                cell.settled ||
                (cell.records ?? 0) > 1 ||
                future
              }
              placeholder="kg"
              size="medium"
              sx={{
                width: 120,
                "& input": {
                  textAlign: "right",
                  fontSize: 20,
                  py: 1.25,
                },
              }}
              slotProps={{
                htmlInput: {
                  inputMode: "decimal",
                  "aria-label": `${workerLabel(w)}, kilos`,
                },
              }}
            />
          </Stack>
        );
      })}
    </Stack>
  );
}

function WeekTable({
  workers,
  cells,
  setCell,
  today,
  busy,
  days,
}: Readonly<GridProps & { days: string[] }>) {
  return (
    <Table size="small" stickyHeader>
      <TableHead>
        <TableRow>
          <TableCell sx={{ fontWeight: 700, minWidth: 160 }}>
            Empleado
          </TableCell>
          {days.map((d, i) => (
            <TableCell
              key={d}
              align="right"
              sx={{ fontWeight: 700, minWidth: 88 }}
            >
              <div>{dayHeader(d, i)}</div>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
                {formatDate(d).slice(0, 5)}
              </Typography>
            </TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {workers.map((w) => (
          <TableRow key={w.id} hover>
            <TableCell sx={{ fontWeight: 600 }}>
              {workerLabel(w)}
            </TableCell>
            {days.map((d) => {
              const cell = cells[cellKey(w.id, d)] ?? emptyCell();
              const future = d > today;
              return (
                <TableCell key={d} align="right" sx={{ p: 0.5 }}>
                  <TextField
                    value={cell.text}
                    onChange={(e) => setCell(w.id, d, e.target.value)}
                    disabled={
                      busy ||
                      cell.settled ||
                      (cell.records ?? 0) > 1 ||
                      future
                    }
                    placeholder={future ? "—" : ""}
                    size="small"
                    sx={{
                      width: 84,
                      "& input": { textAlign: "right", py: 0.75 },
                    }}
                    slotProps={{
                      htmlInput: {
                        inputMode: "decimal",
                        "aria-label": `${workerLabel(w)}, ${dayHeader(d, days.indexOf(d))}`,
                      },
                    }}
                  />
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function PlanillaSheet({
  plotId,
  loadingSheet,
  mode,
  day,
  days,
  ...grid
}: Readonly<
  GridProps & {
    plotId: string;
    loadingSheet: boolean;
    mode: "dia" | "semana";
    day: string;
    days: string[];
  }
>) {
  if (!plotId) {
    return <Alert severity="info">Elija el lote de esta planilla.</Alert>;
  }
  if (loadingSheet) {
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
  const { workers } = grid;
  return (
    <Card>
      <CardContent sx={{ overflowX: "auto" }}>
        {mode === "dia" ? (
          <DayList {...grid} day={day} />
        ) : (
          <WeekTable {...grid} days={days} />
        )}
        {workers.length === 0 && (
          <Alert severity="info" sx={{ mt: 2 }}>
            No hay empleados activos. Regístrelos primero para llenar la
            planilla.
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
