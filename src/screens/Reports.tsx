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
import { useT } from "../i18n";

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

// Shorten a grouping label for the chart axis.
function shortLabel(g: Grouping, label: string) {
  if (g === "week") return label.replace(/^\d{4}-/, ""); // 2026-W33 -> W33
  return label.split(" ")[0]; // first name / first word
}

export default function Reports() {
  const { t } = useT();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [totals, setTotals] = useState({ pickups: 0, kg: 0, people: 0, crops: 0 });
  const [grouping, setGrouping] = useState<Grouping>("week");
  const [rows, setRows] = useState<{ label: string; kg: number; id?: number }[]>([]);
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
      setRows(reportBy(grouping));
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
    labels: top.map((r) => shortLabel(grouping, r.label)),
    datasets: [{ data: top.map((r) => Math.round(r.kg)) }],
  };
  const hasChart = top.length >= 2;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.stats}>
        <Stat label={t("reports.total", { unit })} value={totals.kg.toLocaleString()} />
        <Stat label={t("reports.pickups")} value={String(totals.pickups)} />
        <Stat label={t("reports.toPay")} value={`$${Math.round(payout).toLocaleString()}`} highlight />
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

              {rows.map((b) => {
                const cost =
                  grouping === "week"
                    ? b.kg * costForWeek(b.label, config.costPerUnit)
                    : b.kg * config.costPerUnit;
                const tappable = grouping === "worker" && b.id != null;
                const lots = grouping === "week" ? lotsByWeek[b.label] ?? [] : [];
                const row = (
                  <View style={styles.barRow}>
                    <Text variant="labelLarge" style={styles.barLabel} numberOfLines={1}>
                      {b.label}
                    </Text>
                    <View style={styles.barTrack}>
                      <View style={[styles.barFill, { width: `${(b.kg / max) * 100}%` }]} />
                    </View>
                    <View style={styles.barValues}>
                      <Text variant="labelMedium">{b.kg.toLocaleString()} {unit}</Text>
                      <Text variant="labelSmall" style={styles.cost}>
                        ${Math.round(cost).toLocaleString()}
                      </Text>
                    </View>
                    {tappable && (
                      <MaterialCommunityIcons name="chevron-right" size={18} color="#9aa39a" />
                    )}
                  </View>
                );
                return (
                  <View key={b.label}>
                    {tappable ? (
                      <TouchableRipple
                        borderless
                        onPress={() =>
                          navigation.navigate("WorkerDetail", { personId: b.id! })
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
                            {l.crop} · {l.kg.toLocaleString()} {unit}
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
                  title={`${r.weight.toLocaleString()} ${unit} · ${r.crop}`}
                  description={`${r.person} · ${new Date(r.date).toLocaleString()}`}
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
  barLabel: { width: 92 },
  barTrack: {
    flex: 1,
    height: 14,
    borderRadius: 7,
    backgroundColor: "rgba(46,125,50,0.12)",
    overflow: "hidden",
  },
  barFill: { height: 14, borderRadius: 7, backgroundColor: "#2e7d32" },
  barValues: { width: 92, alignItems: "flex-end" },
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
