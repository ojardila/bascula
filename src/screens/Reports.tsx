import { useCallback, useState } from "react";
import { ScrollView, View, StyleSheet, Dimensions } from "react-native";
import { Text, Card, List, Divider, SegmentedButtons, TouchableRipple } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { BarChart, LineChart } from "react-native-chart-kit";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import {
  Reports as ReportsDb,
  Pickups,
  Config,
  costForWeek,
  totalPayout,
  reportBy,
  weekCrops,
  type Grouping,
  type CropConfig,
} from "../db";
import PerformancePanel from "./PerformancePanel";
import type { Lang } from "../i18n";
import {
  useT,
  formatMoney,
  formatNumber,
  formatWeekRange,
  weekTag,
  formatDay,
  weekNumber,
} from "../i18n";

const CHART_W = Dimensions.get("window").width - 32;
const chartConfig = {
  backgroundGradientFrom: "#ffffff",
  backgroundGradientTo: "#ffffff",
  decimalPlaces: 0,
  color: (o = 1) => `rgba(46,125,50,${o})`,
  labelColor: (o = 1) => `rgba(30,40,30,${o})`,
  barPercentage: 0.6,
  propsForDots: { r: "4", strokeWidth: "2", stroke: "#1b5e20" },
};

// Shorten a grouping label for the chart axis, where there is room for very
// little: week keys become the day and month they start on.
function shortLabel(g: Grouping, label: string, lang: Lang) {
  if (g === "week") return formatDay(label, lang);
  return label.split(" ")[0]; // first name / first word
}

export default function Reports() {
  const { t, lang } = useT();
  // Same pattern as Payments inside Workers: a seventh tab would drop every
  // tab under the 48dp touch target. Reports answers "how much was picked";
  // Performance answers "how well, and at what cost".
  const [view, setView] = useState<"reports" | "perf">("reports");
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [totals, setTotals] = useState({ pickups: 0, kg: 0, people: 0, crops: 0 });
  const [grouping, setGrouping] = useState<Grouping>("week");
  const [rows, setRows] = useState<{ label: string; kg: number; id?: number; value?: number }[]>([]);
  const [lotsByWeek, setLotsByWeek] = useState<Record<string, { crop: string; kg: number }[]>>({});
  const [config, setConfig] = useState<CropConfig>({
    cropType: "cafe",
    label: "Café",
    unit: "kg",
    yieldUnit: "kg por recolector",
    costPerUnit: 800,
  });
  const [payout, setPayout] = useState(0);
  const [recent, setRecent] = useState<
    { id: number; weight: number; date: string; person: string; crop: string }[]
  >([]);

  useFocusEffect(
    useCallback(() => {
      const t = ReportsDb.totals();
      if (t) setTotals(t);
      const c = Config.get();
      if (c) setConfig(c);
      setPayout(totalPayout(c ? c.costPerUnit : 0));
      setRows(reportBy(grouping, c?.costPerUnit ?? 0));
      if (grouping === "week") {
        const map: Record<string, { crop: string; kg: number }[]> = {};
        for (const wc of weekCrops()) {
          (map[wc.week] ??= []).push({ crop: wc.crop, kg: wc.kg });
        }
        setLotsByWeek(map);
      }
      setRecent(Pickups.recent());
    }, [grouping]),
  );

  const unit = config.unit || "kg";
  const max = Math.max(1, ...rows.map((r) => r.kg));
  const title =
    grouping === "week"
      ? t("reports.byWeek")
      : grouping === "worker"
      ? t("reports.byWorker")
      : t("reports.byCrop");

  // Chart takes the top entries; for weeks we show chronological (oldest→newest).
  const top = grouping === "week" ? [...rows].reverse().slice(-8) : rows.slice(0, 6);
  const chartData = {
    labels: top.map((r) => shortLabel(grouping, r.label, lang)),
    datasets: [{ data: top.map((r) => Math.round(r.kg)) }],
  };
  const hasChart = top.length >= 2;

  if (view === "perf") {
    return (
      <View style={styles.flex}>
        <SegmentedButtons
          value={view}
          onValueChange={(v) => setView(v as "reports" | "perf")}
          style={styles.viewSwitch}
          buttons={[
            { value: "reports", label: t("nav.reports"), icon: "chart-bar" },
            { value: "perf", label: t("perf.tab"), icon: "speedometer" },
          ]}
        />
        <PerformancePanel />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <SegmentedButtons
        value={view}
        onValueChange={(v) => setView(v as "reports" | "perf")}
        style={styles.viewSwitch}
        buttons={[
          { value: "reports", label: t("nav.reports"), icon: "chart-bar" },
          { value: "perf", label: t("perf.tab"), icon: "speedometer" },
        ]}
      />
      <View style={styles.stats}>
        <Stat label={t("reports.total", { unit })} value={formatNumber(totals.kg)} />
        <Stat label={t("reports.pickups")} value={String(totals.pickups)} />
        <Stat label={t("reports.toPay")} value={formatMoney(payout)} highlight />
        <Stat label={t("reports.pickers")} value={String(totals.people)} />
      </View>

      <SegmentedButtons
        value={grouping}
        onValueChange={(v) => setGrouping(v as Grouping)}
        buttons={[
          { value: "week", label: t("reports.week"), icon: "calendar-week" },
          { value: "worker", label: t("reports.worker"), icon: "account" },
          { value: "crop", label: t("reports.crop"), icon: "sprout" },
        ]}
      />

      <Card style={styles.card} mode="elevated">
        <Card.Title
          title={title}
          subtitle={hasChart ? t("reports.unitsCollected", { unit }) : undefined}
        />
        <Card.Content>
          {rows.length === 0 ? (
            <Text style={styles.empty}>{t("reports.noPickups")}</Text>
          ) : (
            <>
              {hasChart &&
                (grouping === "week" ? (
                  <LineChart
                    data={chartData}
                    width={CHART_W - 32}
                    height={200}
                    chartConfig={chartConfig}
                    bezier
                    fromZero
                    style={styles.chart}
                  />
                ) : (
                  <BarChart
                    data={chartData}
                    width={CHART_W - 32}
                    height={200}
                    chartConfig={chartConfig}
                    fromZero
                    showValuesOnTopOfBars
                    withInnerLines={false}
                    yAxisLabel=""
                    yAxisSuffix=""
                    style={styles.chart}
                  />
                ))}

              {rows.map((b, idx) => {
                // Weekly rows price their own week; the others carry the value
                // already computed with each week's price, so the same plot no
                // longer shows one number here and another on its detail.
                const cost =
                  grouping === "week"
                    ? b.kg * costForWeek(b.label, config.costPerUnit)
                    : (b.value ?? b.kg * config.costPerUnit);
                const tappable = grouping !== "week" && b.id != null;
                const lots = grouping === "week" ? lotsByWeek[b.label] ?? [] : [];
                const row = (
                  <View style={styles.barRow}>
                    <View style={styles.barLabel}>
                      <Text variant="labelLarge" numberOfLines={1}>
                        {grouping === "week" ? formatWeekRange(b.label, lang) : b.label}
                      </Text>
                      {grouping === "week" && (
                        <Text variant="labelSmall" style={styles.weekNo} numberOfLines={1}>
                          {/* The tag already identifies the week; the number
                              would only be noise next to it. */}
                          {weekTag(b.label, lang) ??
                            t("week.short", { n: weekNumber(b.label) })}
                        </Text>
                      )}
                    </View>
                    <View style={styles.barTrack}>
                      <View style={[styles.barFill, { width: `${(b.kg / max) * 100}%` }]} />
                    </View>
                    <View style={styles.barValues}>
                      <Text variant="labelMedium">{formatNumber(b.kg)} {unit}</Text>
                      <Text variant="labelSmall" style={styles.cost}>
                        {formatMoney(cost)}
                      </Text>
                    </View>
                    {tappable && (
                      <MaterialCommunityIcons name="chevron-right" size={18} color="#9aa39a" />
                    )}
                  </View>
                );
                return (
                  <View key={grouping === "week" ? b.label : `${grouping}-${b.id ?? "x"}-${idx}`}>
                    {tappable ? (
                      <TouchableRipple
                        borderless
                        onPress={() =>
                          grouping === "worker"
                            ? navigation.navigate("WorkerDetail", { personId: b.id! })
                            : navigation.navigate("CropDetail", { cropId: b.id! })
                        }
                      >
                        {row}
                      </TouchableRipple>
                    ) : (
                      row
                    )}
                    {lots.length > 0 && (
                      <View style={styles.lots}>
                        <Text variant="labelSmall" style={styles.lotsLabel}>
                          {t("reports.lots")}:
                        </Text>
                        {lots.map((l) => (
                          <Text key={l.crop} variant="labelSmall" style={styles.lot}>
                            {l.crop} · {formatNumber(l.kg)} {unit}
                          </Text>
                        ))}
                      </View>
                    )}
                  </View>
                );
              })}
            </>
          )}
        </Card.Content>
      </Card>

      <Card style={styles.card} mode="elevated">
        <Card.Title title={t("reports.recent")} />
        <Card.Content style={{ paddingHorizontal: 0 }}>
          {recent.length === 0 ? (
            <Text style={[styles.empty, { paddingHorizontal: 16 }]}>{t("reports.nothing")}</Text>
          ) : (
            recent.map((r, i) => (
              <View key={r.id}>
                {i > 0 && <Divider />}
                <List.Item
                  title={`${formatNumber(r.weight)} ${unit} · ${r.crop}`}
                  description={`${r.person} · ${formatDay(r.date, lang)}`}
                  left={(p) => <List.Icon {...p} icon="scale" />}
                />
              </View>
            ))
          )}
        </Card.Content>
      </Card>
    </ScrollView>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <Card style={styles.stat} mode="contained">
      <Card.Content style={{ alignItems: "center" }}>
        <Text
          variant="titleLarge"
          style={{ fontWeight: "800", color: highlight ? "#1b5e20" : undefined }}
        >
          {value}
        </Text>
        <Text variant="labelMedium" style={{ opacity: 0.7 }}>
          {label}
        </Text>
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 14 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  stat: { flexGrow: 1, minWidth: "45%" },
  card: { borderRadius: 14 },
  chart: { borderRadius: 12, marginVertical: 4, marginLeft: -8 },
  empty: { opacity: 0.6, paddingVertical: 8 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 5 },
  barLabel: { width: 116 },
  barTrack: {
    flex: 1,
    height: 14,
    borderRadius: 7,
    backgroundColor: "rgba(46,125,50,0.12)",
    overflow: "hidden",
  },
  barFill: { height: 14, borderRadius: 7, backgroundColor: "#2e7d32" },
  barValues: { width: 88, alignItems: "flex-end" },
  flex: { flex: 1 },
  viewSwitch: { marginBottom: 12 },
  weekNo: { opacity: 0.55 },
  cost: { opacity: 0.6 },
  lots: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center",
    paddingLeft: 100,
    marginTop: 2,
    marginBottom: 6,
  },
  lotsLabel: { opacity: 0.5 },
  lot: {
    opacity: 0.75,
    backgroundColor: "rgba(46,125,50,0.08)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
});
