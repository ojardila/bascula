// SPDX-License-Identifier: MIT
/**
 * Rows and notices of the crew payroll (`CrewPayrollPage`), split out so the
 * page keeps the flow —filter, settle, pay, undo— and each row reads alone.
 */
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import { Money } from "../../components/Money";
import { formatDate, formatDateRange } from "../../lib/dates";
import { formatMoney, formatQuantity } from "../../lib/money";
import { TeamChip } from "../teams/TeamProfile";
import { BasketTile } from "../workers/Basket";
import {
  balanceCentsOf,
  hasProvisional,
  type CrewMember,
  type PayApproval,
  type SettleApproval,
  type UndoResult,
} from "./crew";

/** Step 1: one account to settle, and its labores when opened. */
export function SettleRow({
  a,
  member,
  included,
  isOpen,
  onToggleIncluded,
  onToggleOpen,
  onPayApart,
}: Readonly<{
  a: SettleApproval;
  member: CrewMember | undefined;
  included: boolean;
  isOpen: boolean;
  onToggleIncluded: () => void;
  onToggleOpen: () => void;
  onPayApart: () => void;
}>) {
  const balance = member ? balanceCentsOf(member) : null;
  return (
    <>
      <TableRow hover>
        <TableCell padding="checkbox">
          <Checkbox
            checked={included}
            onChange={onToggleIncluded}
            slotProps={{
              input: { "aria-label": `Incluir a ${a.name}` },
            }}
          />
        </TableCell>
        <TableCell padding="checkbox">
          <IconButton
            size="small"
            aria-label={`Ver el detalle de ${a.name}`}
            onClick={onToggleOpen}
          >
            {isOpen ? (
              <KeyboardArrowDownIcon />
            ) : (
              <KeyboardArrowRightIcon />
            )}
          </IconButton>
        </TableCell>
        <TableCell sx={{ fontWeight: 600 }}>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.25,
            }}
          >
            <BasketTile
              tag={member?.worker.tag}
              team={member?.worker.kind === "equipo"}
              size={38}
            />
            <Box>
              {a.name}
              {hasProvisional(a) && (
                <Chip
                  size="small"
                  color="warning"
                  variant="outlined"
                  label="provisional"
                  sx={{ ml: 1, height: 20, fontSize: "0.68rem" }}
                />
              )}
              <TeamChip worker={member?.worker} />
            </Box>
          </Box>
        </TableCell>
        <TableCell align="right">{a.lines.length}</TableCell>
        <TableCell align="right">
          {a.quantity === null
            ? "—"
            : `${formatQuantity(a.quantity)} ${a.unitLabel ?? ""}`}
        </TableCell>
        <TableCell align="right">
          {/* Null is null. A "$0" here would say "owed nothing". */}
          {balance === null ? (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              no se pudo leer
            </Typography>
          ) : (
            <Money
              cents={balance}
              variant="small"
              signed
              colored
            />
          )}
        </TableCell>
        <TableCell align="right">
          <Money cents={a.grossCents} variant="small" />
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell sx={{ py: 0, border: 0 }} colSpan={7}>
          <Collapse in={isOpen} unmountOnExit>
            <Box sx={{ py: 1.5, pl: 6 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Actividad</TableCell>
                    <TableCell>Fecha</TableCell>
                    <TableCell align="right">Cantidad</TableCell>
                    <TableCell align="right">Precio</TableCell>
                    <TableCell align="right">Valor</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {a.lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>
                        {l.activityName}
                        {l.rateSource === "weekly_price" && (
                          <Chip
                            size="small"
                            color="warning"
                            variant="outlined"
                            label="provisional"
                            sx={{
                              ml: 1,
                              height: 18,
                              fontSize: "0.62rem",
                            }}
                          />
                        )}
                      </TableCell>
                      <TableCell>
                        {formatDateRange(l.dateFrom, l.dateTo)}
                      </TableCell>
                      <TableCell align="right">
                        {l.unitLabel
                          ? `${formatQuantity(l.quantity)} ${l.unitLabel}`
                          : "contrato"}
                      </TableCell>
                      <TableCell align="right">
                        {`${formatMoney(l.rateCents)}${
                          l.unitLabel ? ` / ${l.unitLabel}` : ""
                        }`}
                      </TableCell>
                      <TableCell align="right">
                        <Money
                          cents={l.amountCents}
                          variant="small"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Button
                size="small"
                sx={{ mt: 1 }}
                onClick={onPayApart}
              >
                Pagarle aparte
              </Button>
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

/** Step 2: one account with a balance to hand over. */
export function PayRow({
  a,
  member,
  included,
  onToggleIncluded,
}: Readonly<{
  a: PayApproval;
  member: CrewMember | undefined;
  included: boolean;
  onToggleIncluded: () => void;
}>) {
  return (
    <TableRow hover>
      <TableCell padding="checkbox">
        <Checkbox
          checked={included}
          onChange={onToggleIncluded}
          slotProps={{
            input: { "aria-label": `Pagar a ${a.name}` },
          }}
        />
      </TableCell>
      <TableCell sx={{ fontWeight: 600 }}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.25,
          }}
        >
          <BasketTile
            tag={member?.worker.tag}
            team={member?.worker.kind === "equipo"}
            size={38}
          />
          <Box>
            {a.name}
            <TeamChip worker={member?.worker} />
          </Box>
        </Box>
      </TableCell>
      <TableCell>{a.documentNumber ?? "—"}</TableCell>
      <TableCell>
        {member?.balance?.lastMovementOn
          ? formatDate(member.balance.lastMovementOn)
          : "—"}
      </TableCell>
      <TableCell align="right">
        <Money cents={a.amountCents} variant="small" />
      </TableCell>
    </TableRow>
  );
}

/** What an undo did, failures included. */
export function UndoneAlert({
  undone,
  onClose,
}: Readonly<{ undone: UndoResult; onClose: () => void }>) {
  return (
    <Alert
      severity={undone.failures.length ? "warning" : "success"}
      sx={{ mb: 2 }}
      onClose={onClose}
    >
      <AlertTitle>Nómina deshecha</AlertTitle>
      Se corrigieron <strong>{undone.paymentsReversed}</strong>{" "}
      {undone.paymentsReversed === 1 ? "pago" : "pagos"} y se anularon{" "}
      <strong>{undone.settlementsVoided}</strong>{" "}
      {undone.settlementsVoided === 1 ? "liquidación" : "liquidaciones"}.
      {undone.alreadyUndone > 0 && (
        <> {undone.alreadyUndone} ya estaban deshechas.</>
      )}
      {undone.failures.length > 0 && (
        <>
          {" "}
          <strong>
            {undone.failures.length} no se pudieron deshacer:
          </strong>{" "}
          {undone.failures.join("; ")}. Quedan en el libro y hay que
          corregirlas a mano desde la ficha del empleado.
        </>
      )}
    </Alert>
  );
}
