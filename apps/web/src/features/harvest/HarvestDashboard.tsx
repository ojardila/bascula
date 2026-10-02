/**
 * «MODO COSECHA»: the harvest week at a glance, on the farm's home screen.
 *
 * Asked for in one sentence: more detail about lotes, rendimiento and people,
 * right at first glance, to see what the crew is doing in the harvest. So,
 * top to bottom, in the order an owner asks at the scale:
 *
 *   1. the week in big figures: kilos this week against last week (over the
 *      same weekdays, so a Wednesday is not compared with a whole week),
 *      kilos today, people today, kilos per person per day, and what the
 *      week's kilos will cost;
 *   2. kilos per day of this week (the chart of the «Rendimiento» section);
 *   3. the lotes, most kilos first, with their share, their people and their
 *      trend — each one opens the lote;
 *   4. the people, most kilos first, with days and kilos per day, and a plain
 *      flag on whoever is well under the farm's average — each one opens the
 *      person's profile, where «Rendimiento» has the detail;
 *   5. who picked lately and has nothing registered today.
 *
 * Every figure comes from GET /v1/reports/harvest-dashboard. This file only
 * words them, and a figure the server could not establish is a dash with its
 * reason (the `Kg`/`Value` readers), never a zero.
 */
import { useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import type { ReactNode } from "react";
import { useAsync } from "../../lib/useAsync";
import { PermissionDenied } from "../../components/Guards";
import { reportHarvestDashboard } from "../../api/harvest";
import type {
  WireHarvestDashboard,
  WireHarvestDashboardPerson,
  WireHarvestDashboardPlot,
} from "../../api/wire";
import { GREEN, moneyFont } from "../../theme";
import { DaysChart } from "../workers/WorkerPerformance";
import { comparisonSpan, kgText, weekChange } from "../workers/performance";
import { count } from "../../lib/plural";
import { EMPLOYEE, PLOT } from "../../lib/vocab";
import { Kg, Value } from "./Figures";
import { belowAverageText, lastSeenText, plotTrend } from "./dashboardText";
import { BasketTile } from "../workers/Basket";

/** How many people are listed before «Ver todas». */
const TOP_PEOPLE = 10;
const TRACK = "rgba(46,125,50,.12)";

export function HarvestDashboard({ canSeeMoney }: { canSeeMoney: boolean }) {
  const { data, error, denied } = useAsync(() => reportHarvestDashboard(), []);

  if (denied) return <PermissionDenied moduleName="ver la cosecha" />;
  if (error) {
    return (
      <Alert severity="error" sx={{ fontSize: "1.05rem" }}>
        No se pudo consultar la semana de cosecha: {error}. Las cifras no se
        pudieron calcular — no son cero.
      </Alert>
    );
  }
  if (!data) {
    return (
      <Stack
        sx={{
          alignItems: "center",
          py: 4,
        }}
      >
        <CircularProgress />
      </Stack>
    );
  }
  return <Body d={data} canSeeMoney={canSeeMoney} />;
}

function Body({
  d,
  canSeeMoney,
}: {
  d: WireHarvestDashboard;
  canSeeMoney: boolean;
}) {
  const s = d.summary;
  if (s.thisWeek.records === 0 && s.lastWeek.records === 0) {
    return (
      <Alert severity="info" sx={{ fontSize: "1.1rem" }}>
        Todavía no hay kilos registrados esta semana ni la semana pasada. Cuando
        se registren recolecciones, aquí verá los lotes, las personas y los
        kilos de cada día.
      </Alert>
    );
  }
  const change = weekChange(s.thisWeek.kg, s.lastWeekToDate.kg);

  return (
    <Stack spacing={3} data-testid="harvest-dashboard">
      {/* 1. The week in big figures. */}
      <Box
        sx={{
          display: "grid",
          gap: 1.5,
          gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(3, 1fr)" },
        }}
      >
        <BigFigure label="Kilos esta semana" wide>
          <Kg total={s.thisWeek} align="flex-start" bold scope="la semana" />
          <Typography
            sx={{
              fontSize: "1.05rem",
              fontWeight: 600,
              mt: 0.5,
              color:
                change.direction === "down"
                  ? "warning.dark"
                  : change.direction === "up"
                    ? "primary.main"
                    : "text.secondary",
            }}
          >
            {change.arrow} {change.sentence}
          </Typography>
          <Typography sx={{ fontSize: "0.95rem", color: "text.secondary" }}>
            {comparisonSpan(d.today)}
          </Typography>
        </BigFigure>
        <BigFigure label="Kilos hoy">
          <Kg total={s.today} align="flex-start" bold scope="hoy" />
        </BigFigure>
        <BigFigure
          label="Personas hoy"
          hint={`De ${count(s.pickersThisWeek, "persona", "personas")} esta semana`}
        >
          {s.pickersToday}
        </BigFigure>
        <BigFigure
          label="Promedio por persona"
          hint="Kilos al día, esta semana"
        >
          {s.kgPerPersonDay === null ? "—" : kgText(s.kgPerPersonDay)}
        </BigFigure>
        {canSeeMoney && (
          <BigFigure
            label="Pago de la semana"
            hint="Lo que valen los kilos recogidos hasta hoy"
          >
            <Value total={s.thisWeek} scope="la semana" align="flex-start" />
          </BigFigure>
        )}
      </Box>
      {s.lastWeek.kg !== null && (
        <Typography sx={{ fontSize: "1.1rem", mt: -1.5 }}>
          La semana pasada completa se recogieron{" "}
          <strong>{kgText(s.lastWeek.kg)}</strong>.
        </Typography>
      )}

      {/* 2. Kilos per day. */}
      <Section title="Kilos por día">
        <DaysChart
          days={d.days}
          caption="Kilos de toda la finca cada día, de lunes a domingo."
        />
      </Section>

      {/* 3. Lotes. */}
      <Section
        title="Lotes"
        hint="Los que más kilos dan esta semana, primero. Toque un lote para ver su detalle."
      >
        {d.plots.length === 0 ? (
          <Typography sx={{ fontSize: "1.05rem", color: "text.secondary" }}>
            Ninguna recolección de estas dos semanas tiene un lote asignado.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {d.plots.map((p) => (
              <PlotRow key={p.plotId} p={p} />
            ))}
          </Stack>
        )}
        {d.unattributed.kg !== null && (
          <Typography
            sx={{ fontSize: "1rem", color: "text.secondary", mt: 1.5 }}
          >
            {kgText(d.unattributed.kg)} de esta semana no tienen un lote
            asignado.
          </Typography>
        )}
      </Section>

      {/* 4. People. */}
      <People d={d} />

      {/* 5. Nothing today. */}
      {d.notToday.length > 0 && (
        <Section
          title="Hoy sin registro"
          hint="Recogieron esta semana o la pasada y hoy todavía no tienen kilos registrados."
        >
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
            {d.notToday.map((p) => (
              <Chip
                key={p.employeeId}
                component={RouterLink}
                to={`${EMPLOYEE.path}/${p.employeeId}`}
                clickable
                label={`${p.tag ? `${p.tag} · ` : ""}${p.name} · recogió ${lastSeenText(p.lastRecordOn, d.today)}`}
                sx={{ fontSize: "1rem", height: 40, borderRadius: 20 }}
              />
            ))}
          </Box>
        </Section>
      )}
    </Stack>
  );
}

function People({ d }: { d: WireHarvestDashboard }) {
  const [all, setAll] = useState(false);
  const people = d.people;
  const shown = all ? people : people.slice(0, TOP_PEOPLE);
  const avg = d.summary.kgPerPersonDay;
  // Named up front, because the list below stops at TOP_PEOPLE and the people
  // most worth a look are, by construction, at the bottom of it.
  const flagged = belowAverageText(
    people.filter((p) => p.belowAverage).map((p) => p.name),
  );
  return (
    <Section
      title="Personas"
      hint={
        avg === null
          ? "Quién más kilos lleva esta semana. Toque una persona para ver su rendimiento."
          : `Promedio de la finca: ${kgText(avg)} por persona al día. Toque una persona para ver su rendimiento.`
      }
    >
      {flagged && (
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: "flex-start",
            mb: 1.5,
            color: "warning.dark",
          }}
        >
          <WarningAmberIcon sx={{ mt: 0.25 }} />
          <Typography sx={{ fontSize: "1.05rem", fontWeight: 600 }}>
            {flagged}
          </Typography>
        </Stack>
      )}
      {people.length === 0 ? (
        <Typography sx={{ fontSize: "1.05rem", color: "text.secondary" }}>
          Nadie ha recogido esta semana todavía.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {shown.map((p, i) => (
            <PersonRow key={p.employeeId} p={p} rank={i + 1} />
          ))}
          {people.length > TOP_PEOPLE && (
            <Button
              variant="outlined"
              size="large"
              onClick={() => setAll((v) => !v)}
              sx={{ alignSelf: "flex-start", fontSize: "1rem" }}
            >
              {all ? "Ver menos" : `Ver las ${people.length} personas`}
            </Button>
          )}
        </Stack>
      )}
    </Section>
  );
}

function PlotRow({ p }: { p: WireHarvestDashboardPlot }) {
  return (
    <RowLink
      to={`${PLOT.path}/${p.plotId}`}
      label={`${p.name}: ${p.kg === null ? "sin kilos" : kgText(p.kg)} esta semana`}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <Typography
          sx={{
            fontSize: "1.15rem",
            fontWeight: 700,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {p.name}
        </Typography>
        <Typography
          sx={{
            fontSize: "1.15rem",
            fontWeight: 700,
            whiteSpace: "nowrap",
            ...moneyFont,
          }}
        >
          {p.kg === null ? "—" : kgText(p.kg)}
        </Typography>
      </Stack>
      <Box
        sx={{
          height: 12,
          borderRadius: 6,
          bgcolor: TRACK,
          overflow: "hidden",
          my: 0.75,
        }}
      >
        <Box
          sx={{
            width: `${Math.round((p.share ?? 0) * 100)}%`,
            height: "100%",
            borderRadius: 6,
            bgcolor: GREEN,
          }}
        />
      </Box>
      <Typography sx={{ fontSize: "1rem", color: "text.secondary" }}>
        {[
          p.share !== null ? `${Math.round(p.share * 100)}% del total` : null,
          count(p.pickers, "persona", "personas"),
          plotTrend(p),
        ]
          .filter(Boolean)
          .join(" · ")}
      </Typography>
    </RowLink>
  );
}

function PersonRow({
  p,
  rank,
}: {
  p: WireHarvestDashboardPerson;
  rank: number;
}) {
  // A team is one row, ranked by kilos EACH: «392 kg c/u · 785 kg juntos».
  const team = p.kind === "equipo";
  const n = Math.round(p.members);
  const main = team ? p.kgEach : p.kg;
  const label = `${rank}. ${p.name}${p.tag ? ` (canasto ${p.tag})` : ""}: ${main === null ? "sin kilos" : kgText(main)}${team && p.kg !== null ? ` cada uno, ${kgText(p.kg)} juntos` : ""}`;
  return (
    <RowLink
      to={`${EMPLOYEE.path}/${p.employeeId}`}
      label={label}
      warn={p.belowAverage}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Stack
          direction="row"
          spacing={1.25}
          sx={{
            alignItems: "center",
            minWidth: 0,
          }}
        >
          <Box
            component="span"
            sx={{
              color: "text.secondary",
              fontWeight: 600,
              fontSize: "1.05rem",
            }}
          >
            {rank}.
          </Box>
          <BasketTile tag={p.tag} team={team} size={40} />
          {/* Wraps instead of «Yorman y …»: with the basket tile in front a
              phone has little room, and half a name is no name. */}
          <Typography
            sx={{
              fontSize: "1.15rem",
              fontWeight: 700,
              lineHeight: 1.2,
              overflowWrap: "anywhere",
            }}
          >
            {p.name}
          </Typography>
        </Stack>
        <Typography
          sx={{
            fontSize: "1.15rem",
            fontWeight: 700,
            whiteSpace: "nowrap",
            ...moneyFont,
          }}
        >
          {main === null ? "—" : kgText(main)}
          {team && (
            <Box
              component="span"
              sx={{ fontSize: "0.95rem", fontWeight: 600, ml: 0.5 }}
            >
              c/u
            </Box>
          )}
        </Typography>
      </Stack>
      {team && (
        <Typography
          sx={{ fontSize: "1rem", fontWeight: 600, color: "success.dark" }}
        >
          Equipo de {n}
          {p.kg !== null ? ` · ${kgText(p.kg)} juntos` : ""}
        </Typography>
      )}
      <Typography sx={{ fontSize: "1rem", color: "text.secondary" }}>
        {count(p.daysWorked, "día", "días")}
        {p.kgPerDay !== null
          ? ` · ${kgText(p.kgPerDay)} al día${team ? " c/u" : ""}`
          : ""}
      </Typography>
      {p.belowAverage && (
        <Stack
          direction="row"
          spacing={0.75}
          sx={{
            alignItems: "center",
            mt: 0.5,
            color: "warning.dark",
          }}
        >
          <WarningAmberIcon fontSize="small" />
          <Typography sx={{ fontSize: "1rem", fontWeight: 600 }}>
            Muy por debajo del promedio
          </Typography>
        </Stack>
      )}
    </RowLink>
  );
}

function RowLink({
  to,
  label,
  warn,
  children,
}: {
  to: string;
  label: string;
  warn?: boolean;
  children: ReactNode;
}) {
  return (
    <ButtonBase
      component={RouterLink}
      to={to}
      aria-label={label}
      focusRipple
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        width: "100%",
        textAlign: "left",
        p: 1.5,
        borderRadius: 2,
        border: 1,
        borderColor: warn ? "warning.main" : "divider",
        bgcolor: warn ? "rgba(237,108,2,.05)" : "background.paper",
        "&:hover": { borderColor: "primary.main" },
        "&.Mui-focusVisible": {
          outline: "3px solid",
          outlineColor: "warning.main",
          outlineOffset: 2,
        },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
      <ChevronRightIcon sx={{ color: "text.secondary", flexShrink: 0 }} />
    </ButtonBase>
  );
}

function BigFigure({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Box
      sx={{
        gridColumn: wide ? { xs: "1 / -1", md: "auto" } : undefined,
        p: 2,
        borderRadius: 3,
        border: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
        minWidth: 0,
      }}
    >
      <Typography
        sx={{ fontSize: "1rem", color: "text.secondary", fontWeight: 600 }}
      >
        {label}
      </Typography>
      <Box
        sx={{
          fontSize: { xs: "1.7rem", sm: "2rem" },
          fontWeight: 700,
          lineHeight: 1.2,
          mt: 0.5,
          ...moneyFont,
        }}
      >
        {children}
      </Box>
      {hint && (
        <Typography
          sx={{ fontSize: "0.95rem", color: "text.secondary", mt: 0.5 }}
        >
          {hint}
        </Typography>
      )}
    </Box>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Box
      sx={{
        p: { xs: 1.5, sm: 2 },
        borderRadius: 3,
        border: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
      }}
    >
      <Typography variant="h3" sx={{ mb: hint ? 0.5 : 1.5 }}>
        {title}
      </Typography>
      {hint && (
        <Typography sx={{ fontSize: "1rem", color: "text.secondary", mb: 1.5 }}>
          {hint}
        </Typography>
      )}
      {children}
    </Box>
  );
}
