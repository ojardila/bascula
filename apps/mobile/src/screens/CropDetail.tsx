import { useCallback, useState } from "react";
import { ScrollView, View, StyleSheet, Dimensions } from "react-native";
import { Text, Card, List, Divider, Chip, Banner } from "react-native-paper";
import { LineChart } from "react-native-chart-kit";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import {
  Crops as CropsDb,
  CropReports,
  Config,
  type Crop,
  type CropConfig,
} from "../db";
import { readHarvest } from "../../../../packages/shared/src/harvest.ts";
import {
  useT,
  formatDay,
  formatWeekRange,
  weekTag,
  mondayOf,
} from "../i18n";

const CHART_W = Dimensions.get("window").width - 32;
const chartConfig = {
  backgroundGradientFrom: "#ffffff",
  backgroundGradientTo: "#ffffff",
  decimalPlaces: 0,
  color: (o = 1) => `rgba(46,125,50,${o})`,
  labelColor: (o = 1) => `rgba(30,40,30,${o})`,
  propsForDots: { r: "4", strokeWidth: "2", stroke: "#1b5e20" },
};

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

export default function CropDetail({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParamList, "CropDetail">) {
  const { t, lang, money, num } = useT();
  const { cropId } = route.params;
  const [crop, setCrop] = useState<Crop | null>(null);
  const [config, setConfig] = useState<CropConfig | null>(null);
  const [stats, setStats] = useState({
    kg: 0,
    pickups: 0,
    pickers: 0,
    days: 0,
    firstDate: "",
    lastDate: "",
  });
  const [byWeek, setByWeek] = useState<ReturnType<typeof CropReports.byWeek>>([]);
  const [byWorker, setByWorker] = useState<ReturnType<typeof CropReports.byWorker>>([]);
  const [recent, setRecent] = useState<ReturnType<typeof CropReports.recent>>([]);
  const [value, setValue] = useState(0);

  useFocusEffect(
    useCallback(() => {
      const found = CropsDb.byId(cropId) ?? null;
      setCrop(found);
      // The plot may have been deleted while its pickups remain; say so instead
      // of showing a nameless screen full of numbers.
      navigation.setOptions({ title: found ? found.name : t("crop.deleted") });
      const c = Config.get();
      setConfig(c ?? null);
      const s = CropReports.stats(cropId);
      if (s) setStats(s);
      setByWeek(CropReports.byWeek(cropId));
      setByWorker(CropReports.byWorker(cropId));
      setRecent(CropReports.recent(cropId));
      setValue(CropReports.value(cropId, c?.costPerUnit ?? 0));
    }, [cropId]),
  );

  const unit = config?.unit || "kg";
  const ha = crop?.dimension ?? 0;
  const weekAsc = [...byWeek].reverse();
  const hasChart = weekAsc.length >= 2;
  // What the weekly totals are saying, and what to do about it.
  const shape = readHarvest(byWeek, mondayOf(new Date()));
  const peak = shape.peak;
  const maxWorkerKg = byWorker.reduce((m, r) => Math.max(m, r.kg), 0);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {shape.windingDown && (
        <Banner visible icon="trending-down" style={styles.banner}>
          {t("crop.windingDown", { n: shape.fallingWeeks })}
        </Banner>
      )}

      <Card style={styles.card} mode="elevated">
        <Card.Content>
          <Text variant="titleLarge" style={{ fontWeight: "800" }}>
            {crop?.name ?? t("crop.deleted")}
          </Text>
          {!!stats.firstDate && (
            <Text variant="labelSmall" style={styles.dim}>
              {formatDay(stats.firstDate, lang)} – {formatDay(stats.lastDate, lang)}
            </Text>
          )}
          <View style={styles.chips}>
            {!!crop?.type && <Chip compact icon="sprout">{crop.type}</Chip>}
            {!!crop?.variety && <Chip compact>{crop.variety}</Chip>}
            {ha > 0 && <Chip compact icon="texture-box">{num(ha)} ha</Chip>}
          </View>
        </Card.Content>
      </Card>

      <View style={styles.stats}>
        <Stat value={num(stats.kg)} label={t("reports.total", { unit })} />
        <Stat
          value={ha > 0 ? `${num(Math.round(stats.kg / ha))}` : "—"}
          label={`${unit}/ha`}
        />
        <Stat value={String(stats.pickers)} label={t("label.workers")} />
      </View>
      <View style={styles.stats}>
        <Stat value={String(stats.days)} label={t("crop.days")} />
        <Stat value={String(stats.pickups)} label={t("reports.pickups")} />
        <Stat value={money(value)} label={t("crop.value")} />
      </View>

      {hasChart && (
        <Card style={styles.card} mode="elevated">
          <Card.Title
            title={t("crop.curve")}
            subtitle={
              peak ? t("crop.peak", { week: formatWeekRange(peak.week, lang) }) : undefined
            }
          />
          <Card.Content>
            <LineChart
              data={{
                labels: weekAsc.map((r) => formatDay(r.week, lang)),
                datasets: [{ data: weekAsc.map((r) => Math.round(r.kg)) }],
              }}
              width={CHART_W - 32}
              height={190}
              chartConfig={chartConfig}
              bezier
              fromZero
              withInnerLines={false}
              yAxisLabel=""
              yAxisSuffix=""
              style={styles.chart}
            />
          </Card.Content>
        </Card>
      )}

      <Card style={styles.card} mode="elevated">
        <Card.Title title={t("crop.pickers")} subtitle={t("crop.pickersSub")} />
        <Card.Content style={{ paddingHorizontal: 0 }}>
          {byWorker.length === 0 ? (
            <Text style={styles.empty}>{t("reports.nothing")}</Text>
          ) : (
            byWorker.map((w, i) => (
              <View key={w.personId}>
                {i > 0 && <Divider />}
                <View style={styles.workerRow}>
                  <View style={styles.workerLabel}>
                    <Text variant="labelLarge" numberOfLines={1}>
                      {w.name}
                    </Text>
                    <Text variant="labelSmall" style={styles.dim}>
                      {t("crop.daysHere", { n: w.days })}
                    </Text>
                  </View>
                  <View style={styles.barTrack}>
                    <View
                      style={[
                        styles.barFill,
                        { width: `${maxWorkerKg ? (w.kg / maxWorkerKg) * 100 : 0}%` },
                      ]}
                    />
                  </View>
                  <View style={styles.workerValues}>
                    <Text variant="labelMedium">
                      {num(w.kg)} {unit}
                    </Text>
                    <Text
                      variant="labelSmall"
                      style={{
                        color:
                          w.irl == null || w.comparableDays < 3
                            ? "#5a6b5c"
                            : w.irl >= 1
                              ? "#1b5e20"
                              : "#8a5a00",
                      }}
                    >
                      {w.irl == null || w.comparableDays < 3 ? "—" : w.irl.toFixed(2)}
                    </Text>
                  </View>
                </View>
              </View>
            ))
          )}
          {byWorker.some((w) => w.irl == null || w.comparableDays < 3) && (
            <Text variant="labelSmall" style={[styles.dim, styles.note]}>
              {t("perf.noBase")}
            </Text>
          )}
        </Card.Content>
      </Card>

      <Card style={styles.card} mode="elevated">
        <Card.Title title={t("crop.weeks")} />
        <Card.Content style={{ paddingHorizontal: 0 }}>
          {byWeek.map((r, i) => (
            <View key={r.week}>
              {i > 0 && <Divider />}
              <List.Item
                title={formatWeekRange(r.week, lang)}
                description={
                  weekTag(r.week, lang) ?? t("perf.pickers", { n: r.pickers })
                }
                right={() => (
                  <Text variant="titleSmall" style={styles.weekKg}>
                    {num(r.kg)} {unit}
                  </Text>
                )}
              />
            </View>
          ))}
        </Card.Content>
      </Card>

      <Card style={styles.card} mode="elevated">
        <Card.Title title={t("reports.recent")} />
        <Card.Content style={{ paddingHorizontal: 0 }}>
          {recent.map((r, i) => (
            <View key={r.id}>
              {i > 0 && <Divider />}
              <List.Item
                title={`${num(r.weight)} ${unit}`}
                description={`${r.person} · ${formatDay(r.date, lang)}`}
                left={(p) => <List.Icon {...p} icon="scale" />}
              />
            </View>
          ))}
        </Card.Content>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, paddingBottom: 32 },
  card: { marginBottom: 12 },
  banner: { marginBottom: 12, backgroundColor: "#fdf5e6" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  stats: { flexDirection: "row", gap: 8, marginBottom: 12 },
  stat: {
    flex: 1,
    backgroundColor: "#ede7f6",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  statValue: { fontWeight: "800" },
  dim: { opacity: 0.78 },
  note: { paddingHorizontal: 16, paddingTop: 10 },
  chart: { borderRadius: 12, marginLeft: -8 },
  empty: { opacity: 0.6, textAlign: "center", padding: 20 },
  workerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  workerLabel: { width: 104 },
  barTrack: {
    flex: 1,
    height: 12,
    borderRadius: 6,
    backgroundColor: "rgba(46,125,50,0.12)",
    overflow: "hidden",
  },
  barFill: { height: "100%", backgroundColor: "#2e7d32", borderRadius: 6 },
  workerValues: { width: 82, alignItems: "flex-end" },
  weekKg: { alignSelf: "center" },
});
