/**
 * LAS CUATRO RAMAS DE UNA TABLA, EN UN SOLO SITIO.
 *
 * El módulo de cosecha ya las separa y las escribe una por una — sin permiso,
 * falló, cargando, vacío — y `ModuleList` también. Las tablas que no pasan por
 * ninguno de los dos no lo hacían: `{(levels ?? []).map(...)}` pinta los
 * encabezados y nada debajo cuando la petición falla, sin una palabra, y quien
 * lo mira concluye que la bodega está vacía. La liquidaciones llegaba más
 * lejos y AFIRMABA que la finca no había liquidado nunca nada.
 *
 * La diferencia que este componente existe para conservar:
 *
 *   cargando   todavía no se sabe. No se afirma nada.
 *   falló      se preguntó y no contestaron. NO ES CERO, y se dice.
 *   sin permiso  no es un fallo y no se reintenta.
 *   vacío      la única de las cuatro que puede afirmar algo sobre la finca.
 *
 * Es una fila de tabla y no una pantalla completa a propósito: el resto de la
 * tabla —los encabezados, el pie, los filtros— sigue siendo útil mientras una
 * de sus fuentes no llega.
 */
import type { ReactNode } from "react";
import { Box, Stack, TableCell, TableRow, Typography } from "@mui/material";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import LockPersonIcon from "@mui/icons-material/LockPerson";

interface Props {
  colSpan: number;
  /** `null` mientras la petición está en el aire. */
  rows: unknown[] | null;
  error?: string | null;
  denied?: boolean;
  /** «las existencias», «los movimientos». Va dentro de las frases. */
  subject: string;
  /** Lo que se dice cuando de verdad no hay nada. */
  emptyText: ReactNode;
  /** Un botón para crear el primero, cuando lo hay. */
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
              {/* La frase que hace falta decir en voz alta, porque una tabla
                  vacía dice lo contrario sola. */}
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
