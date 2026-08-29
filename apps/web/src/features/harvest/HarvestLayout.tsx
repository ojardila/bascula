/**
 * The frame around the five harvest screens.
 *
 * WHY A TAB SET AND NOT FIVE SIDEBAR ENTRIES. The owner's question is "how is
 * the harvest going", and the four other screens are ways of asking it more
 * precisely. Five siblings in the sidebar would make them five subjects.
 *
 * Each tab loads its own report, because each is its own endpoint — the server
 * folds every grid from the same cells, so the totals agree without the client
 * having to hold one dataset and re-derive five views of it.
 *
 * The period lives in the URL rather than in state, so a tab switch keeps it
 * and a link to a particular reading is a link somebody can send.
 */
import { createContext, useContext } from "react";
import { Link as RouterLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Box, Chip, MenuItem, Stack, Tab, Tabs, TextField, Tooltip, Typography } from "@mui/material";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { useAuth } from "../../auth/AuthContext";
import { todayInFarm } from "../../lib/dates";

/** How far back a reading goes. Named in weeks, because a season is weeks. */
export const RANGES = [
  { key: "12", label: "Últimas 12 semanas", weeks: 12 },
  { key: "26", label: "Temporada (6 meses)", weeks: 26 },
  { key: "52", label: "Últimas 52 semanas", weeks: 52 },
] as const;

const DEFAULT_RANGE = "26";

export interface HarvestContext {
  /** Today in the FARM's timezone, not the browser's. */
  today: string;
  weeks: number;
  /** The same window expressed in days, for the endpoints that take one. */
  days: number;
  rangeKey: string;
  canSeeMoney: boolean;
}

const Ctx = createContext<HarvestContext | null>(null);

export function useHarvest(): HarvestContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useHarvest fuera de <HarvestLayout>");
  return ctx;
}

interface TabDef {
  path: string;
  label: string;
  /** Match the path exactly. Only the season tab, which is the index route. */
  exact?: boolean;
}

const TABS: TabDef[] = [
  { path: "/cosecha", label: "Temporada", exact: true },
  { path: "/cosecha/cultivos", label: "Por cultivo" },
  { path: "/cosecha/rendimiento", label: "Rendimiento" },
  { path: "/cosecha/revision", label: "Revisión de pesadas" },
];

export function HarvestLayout() {
  const { user, can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const today = todayInFarm(user?.farm?.timezone || "America/Bogota");
  const rangeKey = new URLSearchParams(location.search).get("rango") ?? DEFAULT_RANGE;
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[1];

  // The week detail hangs off a week and has no tab of its own.
  const onWeek = location.pathname.startsWith("/cosecha/semana/");
  const activeTab = onWeek
    ? false
    : (TABS.find((t) =>
        t.exact ? location.pathname === t.path : location.pathname.startsWith(t.path),
      )?.path ?? "/cosecha");

  const ctx: HarvestContext = {
    today,
    weeks: range.weeks,
    days: range.weeks * 7,
    rangeKey: range.key,
    canSeeMoney: can("money.read"),
  };

  return (
    <Box>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "stretch", sm: "flex-end" }}
        spacing={2}
        sx={{ mb: 2 }}
      >
        <Box>
          <Typography variant="h1">Cosecha</Typography>
          <Typography variant="body2" color="text.secondary">
            La recolección de la finca, semana a semana. Cada pesada sigue siendo una
            labor y se liquida junto con el resto del trabajo de la persona.
          </Typography>
        </Box>
        <TextField
          select
          size="small"
          label="Periodo"
          value={range.key}
          onChange={(e) => navigate(`${location.pathname}?rango=${e.target.value}`)}
          sx={{ minWidth: 210 }}
        >
          {RANGES.map((r) => (
            <MenuItem key={r.key} value={r.key}>
              {r.label}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      <Tabs
        value={activeTab}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}
      >
        {TABS.map((t) => (
          <Tab
            key={t.path}
            value={t.path}
            label={t.label}
            component={RouterLink}
            to={`${t.path}?rango=${range.key}`}
          />
        ))}
      </Tabs>

      <Ctx.Provider value={ctx}>
        <Outlet />
      </Ctx.Provider>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 4, flexWrap: "wrap" }}>
        <Tooltip
          title={
            "Estas cifras cubren el trabajo pagado por unidad de trabajo — la " +
            "recolección. Un jornal no tiene kilos y no entra, así que el valor de " +
            "una semana es lo que valió la recogida, nunca la nómina completa."
          }
        >
          <Chip
            size="small"
            variant="outlined"
            icon={<InfoOutlinedIcon />}
            label="Solo recolección"
            sx={{ cursor: "help" }}
          />
        </Tooltip>
        {ctx.canSeeMoney && (
          <Typography variant="caption" color="text.secondary">
            Un valor marcado <strong>estimado</strong> todavía depende del precio de la
            semana y puede moverse hasta que se liquide.
          </Typography>
        )}
      </Stack>
    </Box>
  );
}
