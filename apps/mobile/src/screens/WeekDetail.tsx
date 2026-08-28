import { useCallback, useMemo, useState } from "react";
import { ScrollView, View, StyleSheet, Dimensions } from "react-native";
import { Text, Card, Divider, DataTable, SegmentedButtons } from "react-native-paper";
import { BarChart } from "react-native-chart-kit";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import { WeekReports, Config, type CropConfig } from "../db";
import { useT, formatWeekRange, formatDay } from "../i18n";

const CHART_W = Dimensions.get("window").width - 64;
const chartConfig = {
  backgroundGradientFrom: "#ffffff",
  backgroundGradientTo: "#ffffff",
  decimalPlaces: 0,
  color: (o = 1) => `rgba(46,125,50,${o})`,
  labelColor: (o = 1) => `rgba(30,40,30,${o})`,
  barPercentage: 0.6,
};

const DAY_LETTER = ["D", "L", "M", "X", "J", "V", "S"];

export default function WeekDetail({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParamList, "WeekDetail">) {
  const { t, lang, num } = useT();
  const { monday } = route.params;
  const [config, setConfig] = useState<CropConfig | null>(null);
  const [byDay, setByDay] = useState<ReturnType<typeof WeekReports.byDay>>([]);
  const [byWorker, setByWorker] = useState<ReturnType<typeof WeekReports.byWorker>>([]);
  const [grid, setGrid] = useState<ReturnType<typeof WeekReports.grid>>([]);
  const [plots, setPlots] = useState<ReturnType<typeof WeekReports.plots>>([]);
  const [gridDay, setGridDay] = useState<ReturnType<typeof WeekReports.gridByDay>>([]);
  // Same people down the side; what runs across the top is the question.
  const [axis, setAxis] = useState<"day" | "plot">("day");

  useFocusEffect(
    useCallback(() => {
      setConfig(Config.get() ?? null);
      setByDay(WeekReports.byDay(monday));
      setByWorker(WeekReports.byWorker(monday));
      setGrid(WeekReports.grid(monday));
      setPlots(WeekReports.plots(monday));
      setGridDay(WeekReports.gridByDay(monday));
      navigation.setOptions({ title: formatWeekRange(monday, lang) });
    }, [monday, lang, navigation]),
  );

  const unit = config?.unit ?? "kg";
  const total = byDay.reduce((s, d) => s + d.kg, 0);

  // person -> column key -> kg, so the table can be read across. The column
  // key is a plot id or a day, depending on which axis is showing.
  const cells = useMemo(() => {
    const m = new Map<number, Map<string, number>>();
    const rows =
      axis === "plot"
        ? grid.map((g) => ({ personId: g.personId, key: String(g.cropId), kg: g.kg }))
        : gridDay.map((g) => ({ personId: g.personId, key: g.day, kg: g.kg }));
    for (const r of rows) {
      if (!m.has(r.personId)) m.set(r.personId, new Map());
      m.get(r.personId)!.set(r.key, r.kg);
    }
    return m;
  }, [grid, gridDay, axis]);

  // The columns and their totals, for whichever axis is showing.
  const columns = useMemo(() => {
    if (axis === "plot") {
      return plots.map((p) => ({ key: String(p.cropId), label: p.crop, total: p.kg }));
    }
    return byDay.map((d) => {
      const dt = new Date(`${d.day}T12:00:00Z`);
      return {
        key: d.day,
        label: `${DAY_LETTER[dt.getUTCDay()]} ${dt.getUTCDate()}`,
        total: d.kg,
      };
    });
  }, [axis, plots, byDay]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.stats}>
        <Stat value={num(total)} label={t("reports.total", { unit })} />
        <Stat value={String(byWorker.length)} label={t("label.workers")} />
        <Stat value={String(plots.length)} label={t("label.crops")} />
      </View>

      {byDay.length > 0 && (
        <Card style={styles.card} mode="elevated">
          <Card.Title title={t("week.byDay")} />
          <Card.Content>
            <BarChart
              data={{
                labels: byDay.map((d) => {
                  const dt = new Date(`${d.day}T12:00:00Z`);
                  return DAY_LETTER[dt.getUTCDay()];
                }),
                datasets: [{ data: byDay.map((d) => Math.round(d.kg)) }],
              }}
              width={CHART_W}
              height={180}
              chartConfig={chartConfig}
              fromZero
              showValuesOnTopOfBars
              withInnerLines={false}
              yAxisLabel=""
              yAxisSuffix=""
              style={styles.chart}
            />
            {byDay.map((d, i) => (
              <View key={d.day}>
                {i > 0 && <Divider />}
                <View style={styles.dayRow}>
                  <Text variant="bodyMedium" style={styles.dayLabel}>
                    {formatDay(d.day, lang)}
                  </Text>
                  <Text variant="labelSmall" style={styles.dim}>
                    {t("week.dayMeta", { p: d.pickers, l: d.plots })}
                  </Text>
                  <Text variant="titleSmall">
                    {num(d.kg)} {unit}
                  </Text>
                </View>
              </View>
            ))}
          </Card.Content>
        </Card>
      )}

      {/* The cross table: who worked which plot. Horizontally scrollable so
          adding plots never squeezes the names into unreadable columns. */}
      <Card style={styles.card} mode="elevated">
        <Card.Title
          title={t("week.grid")}
          subtitle={axis === "plot" ? t("week.gridSub") : t("week.gridSubDay")}
        />
        <Card.Content style={{ paddingHorizontal: 0 }}>
          <View style={styles.axisSwitch}>
            <SegmentedButtons
              value={axis}
              onValueChange={(v) => setAxis(v as "day" | "plot")}
              density="small"
              buttons={[
                { value: "day", label: t("week.byDayAxis"), icon: "calendar-week" },
                { value: "plot", label: t("week.byPlotAxis"), icon: "sprout" },
              ]}
            />
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <DataTable>
              <DataTable.Header>
                <DataTable.Title style={styles.nameCol}>
                  {t("label.workers")}
                </DataTable.Title>
                {columns.map((c) => (
                  <DataTable.Title key={c.key} numeric style={styles.numCol}>
                    {c.label}
                  </DataTable.Title>
                ))}
                <DataTable.Title numeric style={styles.numCol}>
                  {t("week.total")}
                </DataTable.Title>
              </DataTable.Header>

              {byWorker.map((w) => (
                <DataTable.Row key={w.personId}>
                  <DataTable.Cell style={styles.nameCol}>{w.name}</DataTable.Cell>
                  {columns.map((c) => {
                    const kg = cells.get(w.personId)?.get(c.key);
                    return (
                      <DataTable.Cell key={c.key} numeric style={styles.numCol}>
                        {kg ? num(kg) : "—"}
                      </DataTable.Cell>
                    );
                  })}
                  <DataTable.Cell numeric style={styles.numCol}>
                    <Text style={styles.rowTotal}>{num(w.kg)}</Text>
                  </DataTable.Cell>
                </DataTable.Row>
              ))}

              <DataTable.Row>
                <DataTable.Cell style={styles.nameCol}>
                  <Text style={styles.rowTotal}>{t("week.total")}</Text>
                </DataTable.Cell>
                {columns.map((c) => (
                  <DataTable.Cell key={c.key} numeric style={styles.numCol}>
                    <Text style={styles.rowTotal}>{num(c.total)}</Text>
                  </DataTable.Cell>
                ))}
                <DataTable.Cell numeric style={styles.numCol}>
                  <Text style={styles.rowTotal}>{num(total)}</Text>
                </DataTable.Cell>
              </DataTable.Row>
            </DataTable>
          </ScrollView>
        </Card.Content>
      </Card>
    </ScrollView>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text variant="titleMedium" style={styles.statValue}>
        {value}
      </Text>
      <Text variant="labelSmall" style={styles.dim}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, paddingBottom: 32 },
  stats: { flexDirection: "row", gap: 8, marginBottom: 12 },
  stat: {
    flex: 1,
    backgroundColor: "#ede7f6",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  statValue: { fontWeight: "800" },
  dim: { opacity: 0.65 },
  card: { marginBottom: 12 },
  chart: { borderRadius: 12, marginLeft: -16 },
  dayRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
    gap: 8,
  },
  dayLabel: { width: 72 },
  axisSwitch: { paddingHorizontal: 16, paddingBottom: 12 },
  nameCol: { width: 140 },
  numCol: { width: 96 },
  rowTotal: { fontWeight: "700" },
});
