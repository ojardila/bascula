/**
 * RSP-007. One call, four blocks: who they are, what they are owed, what they
 * did, and every peso that ever moved.
 *
 * The two figures in the top right are different things and are shown apart on
 * purpose:
 *
 *   SALDO PENDIENTE — derived from the ledger, every time this page loads.
 *                     Never a stored total; a stored total is a total that one
 *                     day disagrees with its own rows.
 *   PENDIENTE DE LIQUIDAR — work already done that has not been settled, so it
 *                     is not written in the ledger yet and is not part of
 *                     the balance.
 *
 * Merging them into one number would be friendlier and wrong: it would show
 * money as owed before the document that owes it exists.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Grid,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import { visuallyHidden } from "@mui/utils";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import PaymentsIcon from "@mui/icons-material/Payments";
import NoteAddIcon from "@mui/icons-material/NoteAdd";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutlineOutlined";
import GroupsIcon from "@mui/icons-material/Groups";
import {
  TeamMembersCard,
  MemberBanner,
  looksLikeTwoPeople,
} from "../teams/TeamProfile";
import { isTeam, memberCount, teamSize } from "../teams/team";
import { BasketChip, BasketTile, basketOf } from "./Basket";
import { Money } from "../../components/Money";
import { Value } from "../harvest/Figures";
import { totalsOfRecords } from "../harvest/totals";
import { PermissionDenied, Splash } from "../../components/Guards";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { formatDate, formatDateRange } from "../../lib/dates";
import { formatQuantity } from "../../lib/money";
import { RegisterDebtDialog } from "./RegisterDebtDialog";
import { AddNoteDialog } from "./AddNoteDialog";
import { OwedFigure, owedDirection } from "./OwedFigure";
import { totalOwedCents, type Owed } from "./owed";
import { CORRECTION_GLOSS, NOT_YET_EARNED } from "../../lib/vocab";
import { WorkerHistory } from "../receipts/WorkerHistory";
import { WorkerPerformance } from "./WorkerPerformance";

const HISTORY_LIMIT = 500;

export function WorkerProfilePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [debtOpen, setDebtOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  // The whole history, not the first page: it is where a worker's every
  // receipt is found. 500 is the server's ceiling for one read.
  const { data, error, denied, reload } = useAsync(
    () => api.workerProfile(id, HISTORY_LIMIT),
    [id],
  );

  if (denied)
    return <PermissionDenied moduleName="ver el perfil de un empleado" />;
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return <Splash />;

  const { worker, balance, workRecords, pendingCents, ledger, notes } = data;
  /**
   * The project's only definition of "what they are owed", in `owed.ts`.
   * `pendingIsEstimate` comes out of the unsettled work items themselves: on
   * this farm nearly all of them are paid at the week's price, and a figure
   * that can still move must not look like one that cannot.
   */
  const owed: Owed = {
    balanceCents: balance.balanceCents,
    pendingCents,
    pendingIsEstimate: workRecords.some(
      (r) => !r.settled && r.amountIsEstimate,
    ),
  };
  const inFavour = (totalOwedCents(owed) ?? balance.balanceCents) >= 0;
  const team = isTeam(worker);
  // While somebody is in a team their kilos and money go to the team's
  // account; an advance or a deduction of their own is refused by the API.
  const member = !!worker.team;

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate("/empleados")}
        color="inherit"
        sx={{ mb: 1 }}
      >
        Empleados
      </Button>

      {!basketOf(worker.tag) && worker.status !== "inactive" && (
        <Alert
          severity="warning"
          sx={{ mb: 2, fontSize: "1rem" }}
          action={
            can("workers.write") ? (
              <Button
                color="inherit"
                variant="outlined"
                onClick={() =>
                  navigate(
                    `/empleados/${worker.id}/${team ? "equipo" : "editar"}`,
                  )
                }
              >
                Poner número
              </Button>
            ) : undefined
          }
        >
          {team ? "Este equipo" : "Esta persona"} no tiene número de canasto.
          Póngale uno para encontrarl{team ? "o" : "a"} rápido en la báscula.
        </Alert>
      )}

      <Grid container spacing={3} sx={{ mb: 1 }}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Stack
            direction="row"
            spacing={2.5}
            sx={{
              alignItems: "flex-start",
            }}
          >
            <BasketTile tag={worker.tag} team={team} size={88} />
            <Box>
              <Stack
                direction="row"
                spacing={1}
                sx={{
                  alignItems: "center",
                }}
              >
                <Typography variant="h1">
                  {worker.name} {worker.lastName}
                </Typography>
                {worker.status === "inactive" && (
                  <Chip size="small" label="Inactivo" />
                )}
              </Stack>
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{
                  flexWrap: "wrap",
                  mt: 0.5,
                }}
              >
                <BasketChip tag={worker.tag} big />
                {team && (
                  <Chip color="success" label={teamSize(memberCount(worker))} />
                )}
              </Stack>
              {!team && (worker.documentNumber || worker.phone) && (
                <Typography
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  {worker.documentNumber
                    ? `${worker.documentType} ${worker.documentNumber}`
                    : ""}
                  {worker.documentNumber && worker.phone ? " · " : ""}
                  {worker.phone ?? ""}
                </Typography>
              )}
              <Typography
                sx={{
                  color: "text.secondary",
                }}
              >
                {[worker.city, worker.country].filter(Boolean).join(", ")}
              </Typography>
              {worker.startedAt && (
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  Trabaja desde {formatDate(worker.startedAt)}
                </Typography>
              )}

              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{
                  flexWrap: "wrap",
                  mt: 2,
                }}
              >
                {can("money.pay") &&
                  (!member || balance.balanceCents !== 0) && (
                    <Button
                      variant="contained"
                      startIcon={<PaymentsIcon />}
                      onClick={() => navigate(`/empleados/${worker.id}/pagar`)}
                    >
                      {team ? "Liquidar y pagar al equipo" : "Pagar empleado"}
                    </Button>
                  )}
                {can("workers.write") && team && (
                  <Button
                    variant="outlined"
                    startIcon={<GroupsIcon />}
                    onClick={() => navigate(`/empleados/${worker.id}/equipo`)}
                  >
                    Cambiar integrantes
                  </Button>
                )}
                {can("workers.write") &&
                  !team &&
                  !member &&
                  looksLikeTwoPeople(`${worker.name} ${worker.lastName}`) && (
                    <Button
                      variant="outlined"
                      startIcon={<GroupsIcon />}
                      onClick={() => navigate(`/empleados/${worker.id}/equipo`)}
                    >
                      Convertir en equipo
                    </Button>
                  )}
                {can("money.pay") && !member && (
                  <Button
                    variant="outlined"
                    startIcon={<RemoveCircleOutlineIcon />}
                    onClick={() => setDebtOpen(true)}
                  >
                    Registrar deuda
                  </Button>
                )}
                {can("workers.notes") && (
                  <Button
                    variant="outlined"
                    startIcon={<NoteAddIcon />}
                    onClick={() => setNoteOpen(true)}
                  >
                    Agregar anotación
                  </Button>
                )}
              </Stack>
            </Box>
          </Stack>
        </Grid>

        <Grid size={{ xs: 12, md: 5 }}>
          {/* ── THE FIGURE THEY ASKED FOR ────────────────────────────────
              This used to shout the ledger balance —$184.500— with what was
              left to settle in small print below, so the answer to "how much
              do I owe them?" ($338.100) existed only inside the pay screen.
              Anybody who wanted to KNOW without PAYING never saw it, and the
              other three screens said three other things.

              Now the total goes on top and the two halves it comes out of go
              small underneath. `owed.ts` does the adding up, and it is the
              only place in the project where that sum is written. */}
          <Card sx={{ bgcolor: inFavour ? "#eaf3e8" : "#fdecea" }}>
            <CardContent>
              <Typography
                variant="overline"
                sx={{
                  color: "text.secondary",
                }}
              >
                {team
                  ? "Cuenta del equipo · lo que se le debe hoy"
                  : "Lo que se le debe hoy"}
              </Typography>
              <OwedFigure owed={owed} variant="big" align="flex-start" />
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                }}
              >
                {owedDirection(owed) ?? "no se pudo establecer"}
              </Typography>

              <Divider sx={{ my: 1.5 }} />

              {/* The breakdown, using the two names the rest of the console
                  uses, so nobody has to guess which of the two halves is
                  "Pendiente de liquidar". */}
              <Stack spacing={0.5}>
                <Stack
                  direction="row"
                  sx={{
                    justifyContent: "space-between",
                    alignItems: "baseline",
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    Ya liquidado (saldo del libro)
                  </Typography>
                  <Money cents={balance.balanceCents} variant="small" />
                </Stack>
                <Stack
                  direction="row"
                  sx={{
                    justifyContent: "space-between",
                    alignItems: "baseline",
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    Pendiente de liquidar
                  </Typography>
                  {/* "—", not "$0". The figure comes from a request of its own,
                      and when it fails a zero says this person is square with
                      the farm — which is the one thing this line must never say
                      by accident. */}
                  {pendingCents === null ? (
                    <Tooltip title="No se pudo consultar lo pendiente de liquidar. No es cero.">
                      <Typography
                        variant="body2"
                        sx={{
                          color: "text.disabled",
                          fontWeight: 600,
                          cursor: "help",
                        }}
                        aria-label="No se pudo consultar lo pendiente de liquidar. No es cero."
                      >
                        —
                      </Typography>
                    </Tooltip>
                  ) : (
                    <Money cents={pendingCents} variant="small" />
                  )}
                </Stack>
              </Stack>
              <Typography
                variant="caption"
                component="div"
                sx={{
                  color: "text.secondary",
                  mt: 0.5,
                }}
              >
                Lo pendiente es {NOT_YET_EARNED}. Se le entrega igual: liquidar
                es el papel, no la deuda.
              </Typography>
              {balance.lastMovementOn && (
                <Typography
                  variant="caption"
                  component="div"
                  sx={{
                    color: "text.secondary",
                    mt: 1,
                  }}
                >
                  Último movimiento: {formatDate(balance.lastMovementOn)}
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {member && worker.team && <MemberBanner team={worker.team} />}
      {team && <TeamMembersCard team={worker} canEdit={can("workers.write")} />}

      {/* «Rendimiento»: what this person picked, week by week. Harvest
          figures of one person against the farm, so it follows the harvest
          module's permission, not the payroll's. */}
      {can("harvest.read") && <WorkerPerformance workerId={worker.id} />}

      <Card sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h3" gutterBottom>
            Labores
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Actividad</TableCell>
                <TableCell>Fecha</TableCell>
                <TableCell>Lotes</TableCell>
                <TableCell align="right">Cantidad</TableCell>
                <TableCell align="right">Valor</TableCell>
                <TableCell>
                  <Box component="span" sx={visuallyHidden}>
                    Acciones
                  </Box>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {workRecords.map((r) => (
                <TableRow key={r.id}>
                  <TableCell sx={{ fontWeight: 600 }}>
                    {r.activityName}
                  </TableCell>
                  <TableCell>{formatDateRange(r.dateFrom, r.dateTo)}</TableCell>
                  <TableCell>{r.plotNames.join(", ")}</TableCell>
                  <TableCell align="right">
                    {r.payMode === "contract"
                      ? "contrato"
                      : `${formatQuantity(r.quantity)} ${r.unitLabel ?? ""}`}
                  </TableCell>
                  <TableCell align="right">
                    {/* `<Value>` rather than a bare `<Money>`: on this farm
                        every unsettled row is priced by the week, and a figure
                        that can still move must not look like one that
                        cannot. `amountIsEstimate` is the server's own flag and
                        had no reader anywhere in the console. */}
                    <Value total={totalsOfRecords([r])} variant="small" />
                  </TableCell>
                  <TableCell>
                    {r.settled ? (
                      <Chip size="small" label="liquidada" />
                    ) : (
                      <Chip
                        size="small"
                        color="warning"
                        variant="outlined"
                        label="pendiente"
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {workRecords.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} sx={{ color: "text.secondary" }}>
                    Este empleado no tiene labores registradas.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {/* `pendingCents > 0` also hid this whole block when the request had
              simply failed, because the fallback was 0. A failure gets its own
              line now and says so. */}
          {pendingCents === null ? (
            <Stack
              direction="row"
              sx={{
                justifyContent: "flex-end",
                mt: 1,
              }}
            >
              <Typography
                variant="body2"
                sx={{
                  color: "warning.dark",
                }}
              >
                No se pudo consultar lo pendiente de liquidar. No es cero.
              </Typography>
            </Stack>
          ) : (
            pendingCents > 0 && (
              <Stack
                direction="row"
                sx={{
                  justifyContent: "flex-end",
                  mt: 1,
                }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  Pendientes de liquidar:{" "}
                  <Money cents={pendingCents} variant="small" />
                </Typography>
              </Stack>
            )
          )}
        </CardContent>
      </Card>

      {can("money.read") && (
        <Card sx={{ mt: 3 }} id="historial">
          <CardContent>
            <Typography variant="h3" gutterBottom>
              Historial financiero
            </Typography>
            <Typography
              sx={{
                color: "text.secondary",
                fontSize: 16,
                mb: 1,
              }}
            >
              Pagos, liquidaciones, anticipos y descuentos, del más reciente al
              más antiguo. Toque uno para ver el recibo completo y descargarlo
              en PDF.
            </Typography>
            <WorkerHistory workerId={worker.id} ledger={ledger} />
            {/* ── THE LIST CLAIMED TO BE EVERYTHING AND WAS ONE PAGE ────────
                The server cuts the ledger at `ledgerLimit`, and the response
                does not mention it. We say so, with the number, and only when
                there really may be more. */}
            {ledger.length >= data.ledgerLimit && (
              <Typography
                variant="caption"
                component="div"
                sx={{
                  color: "warning.dark",
                  mt: 1,
                }}
              >
                Se muestran los {data.ledgerLimit} movimientos más recientes.
                Puede haber más atrás.
              </Typography>
            )}
            <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
              Nada de esto se edita ni se borra. Un error se corrige con{" "}
              {CORRECTION_GLOSS}
            </Alert>
          </CardContent>
        </Card>
      )}

      <Card sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h3" gutterBottom>
            Anotaciones
          </Typography>
          {notes.map((n) => (
            <Box
              key={n.id}
              sx={{ py: 1, borderBottom: 1, borderColor: "divider" }}
            >
              <Typography
                sx={{
                  fontSize: "1.05rem",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {n.text}
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                }}
              >
                {formatDate(n.date)}
                {n.authorName ? ` · ${n.authorName}` : ""}
              </Typography>
            </Box>
          ))}
          {notes.length === 0 && (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              Sin anotaciones.
            </Typography>
          )}
          <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
            Las anotaciones <strong>no salen de esta finca</strong>. Nunca
            viajan a ninguna consulta entre fincas ni a ningún registro
            nacional.
          </Alert>
        </CardContent>
      </Card>

      <AddNoteDialog
        open={noteOpen}
        workerId={worker.id}
        onClose={() => setNoteOpen(false)}
        onSaved={() => {
          setNoteOpen(false);
          reload();
        }}
      />

      <RegisterDebtDialog
        open={debtOpen}
        workerId={worker.id}
        onClose={() => setDebtOpen(false)}
        onSaved={() => {
          setDebtOpen(false);
          reload();
        }}
      />
    </Box>
  );
}
