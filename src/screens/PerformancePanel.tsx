import { useCallback, useState } from "react";
import { View, ScrollView, StyleSheet } from "react-native";
import { Text, Card, List, Divider, Chip, Banner } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import {
  Config,
  Performance,
  Anomalies,
  type WorkerPerf,
  type Anomaly,
  type CropConfig,
} from "../db";
import { useT, formatMoney, formatNumber, formatDay } from "../i18n";

// Above 1 they beat the crew on the same plot; below, they trailed it.
function irlColor(irl: number | null) {
  if (irl == null) return "#9aa39a";
  if (irl >= 1.15) return "#1b5e20";
  if (irl >= 0.85) return "#4a5a4a";
  return "#8a5a00";
}

export default function PerformancePanel() {
  const { t, lang } = useT();
  const [config, setConfig] = useState<CropConfig | null>(null);
  const [crew, setCrew] = useState<WorkerPerf[]>([]);
  const [plots, setPlots] = useState<ReturnType<typeof Performance.plots>>([]);
  const [cost, setCost] = useState<ReturnType<typeof Performance.realCost> | null>(null);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);

  const load = useCallback(() => {
    const c = Config.get();
    setConfig(c ?? null);
    setCrew(Performance.crew());
    setPlots(Performance.plots());
    setCost(Performance.realCost(c?.costPerUnit ?? 0));
    setAnomalies(Anomalies.all());
  }, []);
  useFocusEffect(load);

  const unit = config?.unit ?? "";
  const crewKgDay = crew.length
    ? crew.reduce((s, r) => s + r.kgPerDay, 0) / crew.length
    : 0;

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      {anomalies.length > 0 && (
        <Banner
          visible
          icon="alert-outline"
          style={styles.banner}
          actions={[]}
        >
          {t("perf.anomalies", { n: anomalies.length })}
        </Banner>
      )}

      <View style={styles.kpis}>
        <Card mode="elevated" style={styles.kpi}>
          <Card.Content>
            <Text variant="labelSmall" style={styles.dim}>
              {t("perf.crewKgDay", { unit })}
            </Text>
            <Text variant="titleLarge" style={styles.kpiValue}>
              {formatNumber(Math.round(crewKgDay * 10) / 10)}
            </Text>
          </Card.Content>
        </Card>
        <Card mode="elevated" style={styles.kpi}>
          <Card.Content>
            <Text variant="labelSmall" style={styles.dim}>
              {t("perf.realCost", { unit })}
            </Text>
            <Text variant="titleLarge" style={styles.kpiValue}>
              {formatMoney(cost?.real ?? 0)}
            </Text>
            {!!cost && cost.budget > 0 && (
              <Text variant="labelSmall" style={styles.dim}>
                {t("perf.budget")} {formatMoney(cost.budget)}
              </Text>
            )}
          </Card.Content>
        </Card>
      </View>

      <Card mode="elevated" style={styles.card}>
        <Card.Title title={t("perf.crew")} subtitle={t("perf.crewSub")} />
        <Card.Content style={{ paddingHorizontal: 0 }}>
          {crew.length === 0 ? (
            <Text style={styles.empty}>{t("perf.empty")}</Text>
          ) : (
            crew.map((r, i) => (
              <View key={r.personId}>
                {i > 0 && <Divider />}
                <List.Item
                  title={r.name}
                  description={`${formatNumber(Math.round(r.kgPerDay * 10) / 10)} ${unit}/${t(
                    "perf.day",
                  )} · ${formatNumber(r.kg)} ${unit}`}
                  right={() => (
                    <View style={styles.irlCell}>
                      <Text
                        variant="titleMedium"
                        style={{ color: irlColor(r.irl), fontWeight: "800" }}
                      >
                        {r.irl == null ? "—" : r.irl.toFixed(2)}
                      </Text>
                      {r.trend != null && r.trend < 0.85 && (
                        <MaterialCommunityIcons
                          name="trending-down"
                          size={18}
                          color="#8a5a00"
                        />
                      )}
                    </View>
                  )}
                />
              </View>
            ))
          )}
          {crew.some((r) => r.irl == null) && (
            <Text variant="labelSmall" style={[styles.dim, styles.note]}>
              {t("perf.noBase")}
            </Text>
          )}
        </Card.Content>
      </Card>

      <Card mode="elevated" style={styles.card}>
        <Card.Title title={t("perf.plots")} />
        <Card.Content style={{ paddingHorizontal: 0 }}>
          {plots.map((p, i) => (
            <View key={p.cropId}>
              {i > 0 && <Divider />}
              <List.Item
                title={p.name}
                description={`${formatNumber(p.kg)} ${unit} · ${t("perf.pickers", {
                  n: p.pickers,
                })}`}
                right={() => (
                  <Text variant="titleSmall" style={styles.perHa}>
                    {p.kgPerHa == null
                      ? t("perf.noArea")
                      : `${formatNumber(Math.round(p.kgPerHa))} ${unit}/ha`}
                  </Text>
                )}
              />
            </View>
          ))}
        </Card.Content>
      </Card>

      {anomalies.length > 0 && (
        <Card mode="elevated" style={styles.card}>
          <Card.Title title={t("perf.review")} />
          <Card.Content style={{ paddingHorizontal: 0 }}>
            {anomalies.map((a, i) => (
              <View key={a.pickupId}>
                {i > 0 && <Divider />}
                <List.Item
                  title={`${formatNumber(a.weight)} ${unit} · ${a.person}`}
                  description={`${formatDay(a.date, lang)} · ${a.crop}`}
                  left={(p) => <List.Icon {...p} icon="alert-outline" color="#8a5a00" />}
                  right={() => (
                    <Chip compact style={styles.ruleChip} textStyle={styles.ruleText}>
                      {t(`perf.rule.${a.rule}`, { n: a.reference })}
                    </Chip>
                  )}
                />
              </View>
            ))}
          </Card.Content>
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 12, paddingBottom: 32 },
  banner: { marginBottom: 12, backgroundColor: "#fdf5e6" },
  kpis: { flexDirection: "row", gap: 8, marginBottom: 12 },
  kpi: { flex: 1 },
  kpiValue: { fontWeight: "800", color: "#1b5e20" },
  card: { marginBottom: 12 },
  dim: { opacity: 0.65 },
  empty: { opacity: 0.6, textAlign: "center", padding: 20 },
  irlCell: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "center" },
  perHa: { alignSelf: "center", opacity: 0.8 },
  note: { paddingHorizontal: 16, paddingTop: 10 },
  ruleChip: { alignSelf: "center", backgroundColor: "#fdf5e6" },
  ruleText: { fontSize: 11 },
});
