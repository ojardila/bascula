import { useCallback, useState } from "react";
import { ScrollView, View, StyleSheet, Dimensions } from "react-native";
import { Text, Card, Avatar, List, Divider, Chip } from "react-native-paper";
import { LineChart } from "react-native-chart-kit";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import { People, WorkerReports, Config, type Person, type CropConfig } from "../db";
import { useT, formatMoney, formatNumber, formatWeekRange, formatDay } from "../i18n";

const CHART_W = Dimensions.get("window").width - 32;
const chartConfig = {
  backgroundGradientFrom: "#ffffff",
  backgroundGradientTo: "#ffffff",
  decimalPlaces: 0,
  color: (o = 1) => `rgba(46,125,50,${o})`,
  labelColor: (o = 1) => `rgba(30,40,30,${o})`,
  propsForDots: { r: "4", strokeWidth: "2", stroke: "#1b5e20" },
};

export default function WorkerDetail({
  route,
}: NativeStackScreenProps<RootStackParamList, "WorkerDetail">) {
  const { t, lang } = useT();
  const { personId } = route.params;
  const [person, setPerson] = useState<Person | null>(null);
  const [stats, setStats] = useState({ kg: 0, pickups: 0, firstDate: "", lastDate: "" });
  const [byWeek, setByWeek] = useState<{ label: string; kg: number }[]>([]);
  const [byCrop, setByCrop] = useState<{ label: string; kg: number }[]>([]);
  const [recent, setRecent] = useState<
    { id: number; weight: number; date: string; crop: string }[]
  >([]);
  const [payout, setPayout] = useState(0);
  const [config, setConfig] = useState<CropConfig | null>(null);

  useFocusEffect(
    useCallback(() => {
      setPerson(People.byId(personId) ?? null);
      const s = WorkerReports.stats(personId);
      if (s) setStats(s);
      setByWeek(WorkerReports.byWeek(personId));
      setByCrop(WorkerReports.byCrop(personId));
      setRecent(WorkerReports.recent(personId));
      const c = Config.get();
      setConfig(c ?? null);
      setPayout(WorkerReports.payout(personId, c ? c.costPerUnit : 0));
    }, [personId]),
  );

  const unit = config?.unit || "kg";
  const days = countDays(stats.firstDate, stats.lastDate);
  const avg = stats.pickups ? stats.kg / stats.pickups : 0;

  const weekAsc = [...byWeek].reverse();
  const hasChart = weekAsc.length >= 2;
  const chartData = {
    labels: weekAsc.map((r) => formatDay(r.label, lang)),
    datasets: [{ data: weekAsc.map((r) => Math.round(r.kg)) }],
  };
  const cropMax = Math.max(1, ...byCrop.map((c) => c.kg));

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* Header */}
      <Card style={styles.card} mode="elevated">
        <Card.Content style={styles.header}>
          {person?.image ? (
            <Avatar.Image size={64} source={{ uri: person.image }} />
          ) : (
            <Avatar.Icon size={64} icon="account" />
          )}
          <View style={{ flex: 1 }}>
            <Text variant="titleLarge" style={{ fontWeight: "800" }}>
              {person ? `${person.name} ${person.lastName}`.trim() : ""}
            </Text>
            <Text style={{ opacity: 0.7 }}>
              {[person?.documentType, person?.docId].filter(Boolean).join(" ")}
            </Text>
            {!!person?.tag && (
              <Chip compact style={styles.tag} icon="card-account-details">
                {person.tag}
              </Chip>
            )}
          </View>
        </Card.Content>
      </Card>

      {/* Stats */}
      <View style={styles.stats}>
        <Stat label={t("reports.total", { unit })} value={formatNumber(stats.kg)} />
        <Stat label={t("reports.pickups")} value={String(stats.pickups)} />
        <Stat label={t("worker.avg", { unit })} value={avg.toFixed(1)} />
        <Stat label={t("worker.days")} value={String(days)} />
        <Stat
          label={t("reports.toPay")}
          value={formatMoney(payout)}
          highlight
        />
      </View>

      {/* By week */}
      <Card style={styles.card} mode="elevated">
        <Card.Title title={t("worker.byWeek")} />
        <Card.Content>
          {hasChart ? (
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
            <Text style={styles.empty}>{t("reports.noPickups")}</Text>
          )}
        </Card.Content>
      </Card>

      {/* By crop */}
      {byCrop.length > 0 && (
        <Card style={styles.card} mode="elevated">
          <Card.Title title={t("worker.byCrop")} />
          <Card.Content>
            {byCrop.map((c) => (
              <View key={c.label} style={styles.barRow}>
                <Text variant="labelLarge" style={styles.barLabel} numberOfLines={1}>
                  {c.label}
                </Text>
                <View style={styles.barTrack}>
                  <View style={[styles.barFill, { width: `${(c.kg / cropMax) * 100}%` }]} />
                </View>
                <Text variant="labelMedium" style={styles.barValue}>
                  {formatNumber(c.kg)} {unit}
                </Text>
              </View>
            ))}
          </Card.Content>
        </Card>
      )}

      {/* Recent */}
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
                  description={formatDay(r.date, lang)}
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

function countDays(first: string, last: string) {
  if (!first || !last) return 0;
  const a = new Date(first).getTime();
  const b = new Date(last).getTime();
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
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
          variant="titleMedium"
          style={{ fontWeight: "800", color: highlight ? "#1b5e20" : undefined }}
        >
          {value}
        </Text>
        <Text variant="labelSmall" style={{ opacity: 0.7, textAlign: "center" }}>
          {label}
        </Text>
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 14 },
  card: { borderRadius: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 14 },
  tag: { alignSelf: "flex-start", marginTop: 6 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  stat: { flexGrow: 1, minWidth: "30%" },
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
  barValue: { width: 78, textAlign: "right" },
});
