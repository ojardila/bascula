/** The team parts of a worker's profile (docs/use-cases/teams.md, TEAM-05/06). */
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  CardContent,
  List,
  ListItemButton,
  ListItemText,
  Typography,
} from "@mui/material";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import type { TeamRef, Worker } from "../../api/types";
import { formatDate } from "../../lib/dates";
import { BasketTile } from "../workers/Basket";

/** «Yorman y Sergio», «Ana & Luis»: a name that is probably two people. */
export function looksLikeTwoPeople(name: string): boolean {
  return /\S\s+(y|&|e)\s+\S/i.test(name.trim());
}

export function TeamMembersCard({
  team,
  canEdit,
}: {
  team: Worker;
  canEdit: boolean;
}) {
  const navigate = useNavigate();
  const members = team.members ?? [];
  return (
    <Card sx={{ mt: 3 }}>
      <CardContent>
        <Typography variant="h3" gutterBottom>
          Integrantes
        </Typography>
        {members.length === 0 ? (
          <Alert severity="warning" sx={{ fontSize: "1.05rem" }}>
            Este equipo todavía no tiene integrantes. Márquelos para que los
            promedios cuenten bien a las personas.
          </Alert>
        ) : (
          <List disablePadding>
            {members.map((m) => (
              <ListItemButton
                key={m.id}
                divider
                onClick={() => navigate(`/empleados/${m.id}`)}
                sx={{ py: 1.25 }}
              >
                <BasketTile tag={m.tag} size={44} sx={{ mr: 1.5 }} />
                <ListItemText
                  primary={`${m.name} ${m.lastName ?? ""}`.trim()}
                  secondary={`Desde ${formatDate(m.from)}${m.to ? ` hasta ${formatDate(m.to)}` : ""}${m.tag ? ` · canasto ${m.tag}` : " · sin canasto"}`}
                  slotProps={{
                    primary: { sx: { fontWeight: 700, fontSize: "1.1rem" } },
                    secondary: { sx: { fontSize: "0.95rem" } },
                  }}
                />
                <ChevronRightIcon color="action" />
              </ListItemButton>
            ))}
          </List>
        )}
        {canEdit && (
          <Button
            sx={{ mt: 1, fontSize: "1.05rem" }}
            onClick={() => navigate(`/empleados/${team.id}/equipo`)}
          >
            Cambiar integrantes
          </Button>
        )}
        <Typography
          sx={{
            color: "text.secondary",
            mt: 1,
          }}
        >
          Las pesadas, la liquidación y los pagos van a nombre del equipo. Cómo
          se reparten la plata es cosa de ellos.
        </Typography>
      </CardContent>
    </Card>
  );
}

export function MemberBanner({ team }: { team: TeamRef }) {
  const navigate = useNavigate();
  return (
    <Alert
      severity="info"
      sx={{ mt: 3, fontSize: "1.1rem", alignItems: "center" }}
      action={
        <Button
          color="inherit"
          onClick={() => navigate(`/empleados/${team.id}`)}
          sx={{ fontSize: "1rem" }}
        >
          Ver el equipo
        </Button>
      }
    >
      Está en el equipo <strong>{team.name}</strong> desde el{" "}
      {formatDate(team.from)}
      {team.to ? ` hasta el ${formatDate(team.to)}` : ""}. Sus kilos y sus pagos
      van a la cuenta del equipo. Abajo se ve <strong>su parte</strong>.
    </Alert>
  );
}

/** On a payroll row: «Equipo de 2 · Yorman, Sergio». Nothing for a person. */
export function TeamChip({ worker }: { worker: Worker | undefined | null }) {
  if (!worker || worker.kind !== "equipo") return null;
  const n = worker.members?.length ?? 0;
  const names = (worker.members ?? []).map((m) => m.name).join(", ");
  return (
    <Typography
      component="span"
      sx={{
        display: "block",
        fontSize: "0.85rem",
        fontWeight: 600,
        color: "success.dark",
      }}
    >
      Equipo de {n}
      {names ? ` · ${names}` : ""}
    </Typography>
  );
}
