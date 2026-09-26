/**
 * «COSECHA»: the screen the farm opens every day. Kept simple on purpose.
 *
 * It is read by people around fifty who don't live in software, so it says
 * three things and offers two actions:
 *
 *  - This week in big figures: kilos, value (only for whoever may see money)
 *    and how many people picked, plus one plain sentence about last week.
 *  - Kilos per day of this week, as a short list with a bar.
 *  - Two buttons of equal weight: «Registrar la semana» (everybody, day by
 *    day) and «Registrar una recolección» (one person, one weighing).
 *
 * The season history, per crop, the yield index and the weighing review are
 * one discreet link away («Ver más detalles»), so nothing was removed.
 *
 * A figure the server could not establish is a dash with its reason, never
 * a zero — the same `Kg`/`Value` readers the detailed screens use.
 */
import { Link as RouterLink } from "react-router-dom";
import { Alert, Box, ButtonBase, CircularProgress, Link, Stack, Typography } from "@mui/material";
import CalendarViewWeekIcon from "@mui/icons-material/CalendarViewWeek";
import ScaleIcon from "@mui/icons-material/Scale";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import type { ReactNode } from "react";
import { useAsync } from "../../lib/useAsync";
import { PermissionDenied } from "../../components/Guards";
import { reportWeek, reportWeeks } from "../../api/harvest";
import { formatQuantity } from "../../lib/money";
import { addDays, formatWeekRange, mondayOf, parseDay } from "../../lib/dates";
import { useAuth } from "../../auth/AuthContext";
import { useHarvest } from "./HarvestLayout";
import { Kg, Value } from "./Figures";
import { kgForDrawing } from "./totals";

const DAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"] as const;

export function CosechaHome() {
  const { today, canSeeMoney } = useHarvest();
  const { can } = useAuth();
  const thisMonday = mondayOf(today);
  const lastMonday = addDays(parseDay(thisMonday), -7).toISOString().slice(0, 10);

  const { data, error, denied } = useAsync(
    async () => Promise.all([reportWeek(thisMonday), reportWeeks({ limit: 2 })]),
    [thisMonday],
  );

  const canWrite = can("workRecords.write");

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h1">Cosecha</Typography>
        <Typography sx={{ fontSize: "1.1rem" }} color="text.secondary">
          Esta semana · {formatWeekRange(thisMonday)}
        </Typography>
      </Box>

      {canWrite && (
        <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
          <BigAction
            to="/cosecha/registrar-semana"
            icon={<CalendarViewWeekIcon sx={{ fontSize: 40 }} />}
            title="Registrar la semana"
            hint="Los kilos de todos los empleados, día por día"
          />
          <BigAction
            to="/cosecha/recoleccion"
            icon={<ScaleIcon sx={{ fontSize: 40 }} />}
            title="Registrar una recolección"
            hint="Una persona, una pesada"
          />
        </Box>
      )}

      {denied ? (
        <PermissionDenied moduleName="ver la cosecha" />
      ) : error ? (
        <Alert severity="error">
          No se pudo consultar la cosecha: {error}. Las cifras no se pudieron calcular — no son cero.
        </Alert>
      ) : !data ? (
        <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress /></Stack>
      ) : (
        <WeekSummary
          week={data[0]}
          lastWeek={data[1].items.find((w) => w.weekStart === lastMonday) ?? null}
          canSeeMoney={canSeeMoney}
        />
      )}

      <Box sx={{ pt: 1 }}>
        <Link
          component={RouterLink}
          to="/cosecha/detalles"
          underline="hover"
          sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontSize: "1.05rem", fontWeight: 600 }}
        >
          Ver más detalles
          <ChevronRightIcon fontSize="small" />
        </Link>
        <Typography variant="body2" color="text.secondary">
          Temporada, por cultivo, rendimiento y revisión de pesadas.
        </Typography>
      </Box>
    </Stack>
  );
}

function BigAction({ to, icon, title, hint }: { to: string; icon: ReactNode; title: string; hint: string }) {
  return (
    <ButtonBase
      component={RouterLink}
      to={to}
      focusRipple
      sx={{
        justifyContent: "flex-start",
        textAlign: "left",
        gap: 2,
        p: { xs: 2, sm: 2.5 },
        minHeight: 96,
        borderRadius: 4,
        bgcolor: "primary.main",
        color: "#fff",
        boxShadow: 2,
        "&:hover": { bgcolor: "primary.dark" },
        "&.Mui-focusVisible": { outline: "3px solid", outlineColor: "warning.main", outlineOffset: 2 },
      }}
    >
      <Box sx={{ display: "flex", flexShrink: 0 }}>{icon}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography component="span" sx={{ display: "block", fontSize: { xs: "1.3rem", sm: "1.4rem" }, fontWeight: 700, lineHeight: 1.25 }}>
          {title}
        </Typography>
        <Typography component="span" sx={{ display: "block", fontSize: "1rem", opacity: 0.9 }}>
          {hint}
        </Typography>
      </Box>
    </ButtonBase>
  );
}

function BigFigure({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <Box sx={{ gridColumn: wide ? { xs: "1 / -1", md: "auto" } : undefined, p: 2, borderRadius: 3, border: 1, borderColor: "divider", bgcolor: "background.paper", minWidth: 0 }}>
      <Typography sx={{ fontSize: "1rem", color: "text.secondary", fontWeight: 600 }}>{label}</Typography>
      <Box sx={{ fontSize: { xs: "1.7rem", sm: "2rem" }, fontWeight: 700, lineHeight: 1.2, mt: 0.5 }}>{children}</Box>
    </Box>
  );
}

function WeekSummary({
  week,
  lastWeek,
  canSeeMoney,
}: {
  week: Awaited<ReturnType<typeof reportWeek>>;
  lastWeek: { kg: number | null } | null;
  canSeeMoney: boolean;
}) {
  const pickers = week.byDay.rows.length;
  const dayCols = week.byDay.columns.filter((c) => c.key);
  const maxKg = Math.max(...dayCols.map((c) => kgForDrawing(c.total)), 1);

  return (
    <Stack spacing={2.5}>
      <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr 1fr", md: canSeeMoney ? "repeat(3,1fr)" : "repeat(2,1fr)" } }}>
        <BigFigure label="Kilos esta semana" wide={canSeeMoney}>
          <Kg total={week.total} align="flex-start" bold scope="la semana" />
        </BigFigure>
        {canSeeMoney && (
          <BigFigure label="Valor">
            <Value total={week.total} scope="la semana" align="flex-start" />
          </BigFigure>
        )}
        <BigFigure label="Recolectores">{pickers}</BigFigure>
      </Box>

      {lastWeek?.kg != null && (
        <Typography sx={{ fontSize: "1.1rem" }}>
          La semana pasada se recogieron <strong>{formatQuantity(lastWeek.kg)} kg</strong>.
        </Typography>
      )}

      {week.total.records === 0 ? (
        <Alert severity="info" sx={{ fontSize: "1.05rem" }}>
          Todavía no hay kilos registrados esta semana.
        </Alert>
      ) : (
        <Box sx={{ p: 2, borderRadius: 3, border: 1, borderColor: "divider", bgcolor: "background.paper" }}>
          <Typography variant="h3" sx={{ mb: 1.5 }}>Kilos por día</Typography>
          <Stack spacing={1}>
            {dayCols.map((c) => {
              const i = (parseDay(c.key!).getUTCDay() + 6) % 7;
              const kg = kgForDrawing(c.total);
              return (
                <Stack key={c.key} direction="row" alignItems="center" spacing={1.5}>
                  <Typography sx={{ width: { xs: 124, sm: 130 }, flexShrink: 0, fontSize: "1.05rem" }}>
                    {DAY_NAMES[i]} {parseDay(c.key!).getUTCDate()}
                  </Typography>
                  <Box sx={{ flex: 1, height: 14, borderRadius: 7, bgcolor: "#eef1ec", overflow: "hidden" }}>
                    <Box sx={{ width: `${(kg / maxKg) * 100}%`, height: "100%", bgcolor: "primary.main", borderRadius: 7 }} />
                  </Box>
                  <Box sx={{ width: 96, flexShrink: 0, textAlign: "right", fontSize: "1.05rem", fontWeight: 600 }}>
                    <Kg total={c.total} scope="ese día" />
                  </Box>
                </Stack>
              );
            })}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
