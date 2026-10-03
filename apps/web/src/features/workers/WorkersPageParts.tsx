// SPDX-License-Identifier: MIT
/**
 * Pieces of the employee list (`WorkersPage`), split out so each one can be
 * read on its own: the name cell, the footer and the row actions.
 */
import { Box, Button, Chip, Stack, Tooltip, Typography } from "@mui/material";
import GroupsIcon from "@mui/icons-material/Groups";
import type { ModuleListProps } from "../../components/ModuleList";
import type { Action } from "../../auth/permissions";
import { Money } from "../../components/Money";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import type { Worker } from "../../api/types";
import { EMPLOYEE, PROVISIONAL_INCLUDES } from "../../lib/vocab";
import { isTeam, memberNames, memberCount, teamSize } from "../teams/team";
import { NoBasketChip, BasketTile, basketOf } from "./Basket";
import type { OwedSum } from "./owed";

/** Where "edit" goes for this row: teams have their own form. */
export const editPathOf = (w: Worker) =>
  `${EMPLOYEE.path}/${w.id}/${isTeam(w) ? "equipo" : "editar"}`;

/** Under the name: the team's members, or the team a person belongs to. */
function TeamLine({ w }: Readonly<{ w: Worker }>) {
  if (isTeam(w)) {
    return (
      <Stack
        direction="row"
        spacing={0.75}
        useFlexGap
        sx={{
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <Chip
          size="small"
          color="success"
          variant="outlined"
          label={teamSize(memberCount(w))}
        />
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          {memberNames(w) || "Sin integrantes"}
        </Typography>
      </Stack>
    );
  }
  if (!w.team) return null;
  return (
    <Typography
      variant="caption"
      sx={{
        color: "success.dark",
        display: "block",
        fontWeight: 600,
      }}
    >
      En el equipo {w.team.name}
    </Typography>
  );
}

export function WorkerNameCell({
  w,
  full,
  onFixBasket,
}: Readonly<{
  w: Worker;
  full: boolean;
  onFixBasket?: () => void;
}>) {
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{
        alignItems: "center",
      }}
    >
      <BasketTile tag={w.tag} team={isTeam(w)} />
      <Box>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <Typography sx={{ fontWeight: 600, fontSize: "1.05rem" }}>
            {w.name} {w.lastName}
          </Typography>
          {!basketOf(w.tag) && <NoBasketChip onClick={onFixBasket} />}
        </Stack>
        <TeamLine w={w} />
        {full && !isTeam(w) && (w.documentNumber || !w.team) && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {w.documentType} {w.documentNumber}
          </Typography>
        )}
      </Box>
    </Stack>
  );
}

/** The footer total: "…" while loading, a dash with its reason, or the sum. */
function FarmOwesFigure({
  loading,
  cents,
}: Readonly<{ loading: boolean; cents: number | null }>) {
  if (loading) return <>…</>;
  if (cents === null) {
    return (
      <Tooltip title="No se pudo consultar ninguna cuenta. No es cero.">
        <Box
          component="span"
          sx={{
            color: "text.disabled",
            fontWeight: 700,
            cursor: "help",
          }}
        >
          —
        </Box>
      </Tooltip>
    );
  }
  return <Money cents={cents} variant="small" />;
}

export function WorkersFooter({
  count,
  loading,
  farmOwes,
}: Readonly<{ count: number; loading: boolean; farmOwes: OwedSum }>) {
  return (
    <Stack
      direction="row"
      spacing={2}
      useFlexGap
      sx={{
        flexWrap: "wrap",
      }}
    >
      <span>
        {count} {count === 1 ? "empleado" : "empleados"}
      </span>
      <span>
        La finca les debe:{" "}
        <FarmOwesFigure loading={loading} cents={farmOwes.cents} />
        {farmOwes.isEstimate && ` (${PROVISIONAL_INCLUDES})`}
      </span>
      {/* The sum says how many people it covers. A total with people
          left out of it, unannounced, is the same lie we fixed
          above. */}
      {!loading && farmOwes.unreadable > 0 && (
        <Box component="span" sx={{ color: "warning.dark" }}>
          {farmOwes.unreadable === 1
            ? "1 cuenta no se pudo leer y queda fuera de esa suma."
            : `${farmOwes.unreadable} cuentas no se pudieron leer y quedan fuera de esa suma.`}
        </Box>
      )}
    </Stack>
  );
}

type WorkerActions = Pick<
  ModuleListProps<Worker>,
  | "onCreate"
  | "onRowClick"
  | "onEdit"
  | "toolbarExtra"
  | "extraActions"
  | "onDeactivate"
  | "onReactivate"
>;

/**
 * What each row and the toolbar let this session do. A permission the
 * session lacks leaves the action out, so the list does not offer it.
 */
export function workerListActions(
  can: (action: Action) => boolean,
  navigate: (to: string) => void,
  reload: () => void,
  setActionError: (message: string) => void,
): WorkerActions {
  const actions: WorkerActions = {};

  if (can("workers.write")) {
    actions.onCreate = () => navigate(`${EMPLOYEE.path}/nuevo`);
    actions.onEdit = (w) => navigate(editPathOf(w));
    actions.toolbarExtra = (
      <Button
        variant="outlined"
        startIcon={<GroupsIcon />}
        onClick={() => navigate(`${EMPLOYEE.path}/equipo/nuevo`)}
      >
        Nuevo equipo
      </Button>
    );
  }

  if (can("workers.profile")) {
    actions.onRowClick = (w) => navigate(`${EMPLOYEE.path}/${w.id}`);
  }

  if (can("money.pay")) {
    actions.extraActions = (w) => {
      const team = w.team;
      if (team) {
        return [
          {
            label: "Ver su equipo",
            onClick: () => navigate(`${EMPLOYEE.path}/${team.id}`),
          },
        ];
      }
      return [
        {
          label: "Pagar",
          onClick: () => navigate(`${EMPLOYEE.path}/${w.id}/pagar`),
        },
      ];
    };
  }

  if (can("workers.delete")) {
    const run = async (call: () => Promise<unknown>) => {
      try {
        await call();
        reload();
      } catch (e) {
        setActionError(messageFor(e));
      }
    };
    actions.onDeactivate = (w) => run(() => api.deactivateWorker(w.id));
    // Their old basket number may have been given to somebody else
    // meanwhile: the message says who has it.
    actions.onReactivate = (w) => run(() => api.reactivateWorker(w.id));
  }

  return actions;
}
