/**
 * THE FOUR BRANCHES OF A TABLE, IN ONE PLACE.
 *
 * The harvest module already tells them apart and writes each one out — not
 * allowed, failed, loading, empty — and so does `ModuleList`. The tables that
 * go through neither did not: `{(levels ?? []).map(...)}` paints the headers
 * and nothing underneath when the request fails, without a word, and whoever
 * looks at it concludes the store is empty. The settlements table went further
 * and CLAIMED the farm had never settled anything.
 *
 * The distinction this component exists to preserve:
 *
 *   loading      we do not know yet. Nothing is claimed.
 *   failed       we asked and got no answer. IT IS NOT ZERO, and we say so.
 *   not allowed  not a failure, and not something to retry.
 *   empty        the only one of the four that may claim anything about the farm.
 *
 * It is a table row and not a whole screen on purpose: the rest of the table
 * —the headers, the footer, the filters— stays useful while one of its sources
 * has not arrived.
 */
import type { ReactNode } from "react";
import { Box, Stack, TableCell, TableRow, Typography } from "@mui/material";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import LockPersonIcon from "@mui/icons-material/LockPerson";

interface Props {
  colSpan: number;
  /** `null` while the request is still in the air. */
  rows: unknown[] | null;
  error?: string | null;
  denied?: boolean;
  /** "las existencias", "las entradas y salidas". Goes inside the sentences. */
  subject: string;
  /** What we say when there really is nothing. */
  emptyText: ReactNode;
  /** A button to create the first one, where there is one. */
  emptyAction?: ReactNode;
}

export function TableState({
  colSpan,
  rows,
  error,
  denied,
  subject,
  emptyText,
  emptyAction,
}: Props) {
  if (denied) {
    return (
      <TableRow>
        <TableCell colSpan={colSpan} sx={{ py: 4, color: "text.secondary" }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <LockPersonIcon fontSize="small" color="warning" />
            <span>
              Su usuario no tiene permiso para ver {subject}. Si lo necesita para
              trabajar, pídaselo al dueño de la finca.
            </span>
          </Stack>
        </TableCell>
      </TableRow>
    );
  }

  if (error) {
    return (
      <TableRow>
        <TableCell colSpan={colSpan} sx={{ py: 4 }}>
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <ErrorOutlineIcon fontSize="small" color="error" />
            <Box>
              <Typography sx={{ fontWeight: 600 }}>
                No se pudieron consultar {subject}.
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {error}
              </Typography>
              {/* The sentence that has to be said out loud, because an empty
                  table says the opposite all by itself. */}
              <Typography variant="body2" color="warning.dark">
                Esta tabla está vacía porque falló la consulta, no porque no haya nada.
              </Typography>
            </Box>
          </Stack>
        </TableCell>
      </TableRow>
    );
  }

  if (rows === null) {
    return (
      <TableRow>
        <TableCell colSpan={colSpan} sx={{ py: 4, color: "text.secondary" }}>
          Consultando {subject}…
        </TableCell>
      </TableRow>
    );
  }

  if (rows.length === 0) {
    return (
      <TableRow>
        <TableCell colSpan={colSpan} sx={{ py: 4, color: "text.secondary" }}>
          {emptyText}
          {emptyAction}
        </TableCell>
      </TableRow>
    );
  }

  return null;
}
