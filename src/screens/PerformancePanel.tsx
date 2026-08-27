import { useCallback, useState } from "react";
import { View, ScrollView, StyleSheet } from "react-native";
import {
  Text,
  Card,
  List,
  Divider,
  Chip,
  Banner,
  Portal,
  Dialog,
  Button,
  TextInput,
  Snackbar,
} from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import {
  Config,
  Performance,
  Anomalies,
  Pickups,
  type WorkerPerf,
  type Anomaly,
  type CropConfig,
} from "../db";
import {
  useT,
  formatMoney,
  formatNumber,
  formatDay,
  formatWeekRange,
  mondayOf,
} from "../i18n";

// Above 1 they beat the crew on the same plot; below, they trailed it.
function irlColor(irl: number | null) {
  if (irl == null) return "#9aa39a";
  if (irl >= 1.15) return "#1b5e20";
  if (irl >= 0.85) return "#4a5a4a";
  return "#8a5a00";
}

export default function PerformancePanel() {
  const { t, lang } = useT();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [config, setConfig] = useState<CropConfig | null>(null);
  const [crew, setCrew] = useState<WorkerPerf[]>([]);
  const [plots, setPlots] = useState<ReturnType<typeof Performance.plots>>([]);
  const [cost, setCost] = useState<ReturnType<typeof Performance.realCost> | null>(null);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [priceRows, setPriceRows] = useState<ReturnType<typeof Performance.priceResponse>>([]);
  // A flagged pickup the user is deciding about. Detection alone is not much
  // use if the wrong number has to stay in the books.
  const [review, setReview] = useState<Anomaly | null>(null);
  const [newWeight, setNewWeight] = useState("");
  const [snack, setSnack] = useState("");

  const load = useCallback(() => {
    const c = Config.get();
    setConfig(c ?? null);
    setCrew(Performance.crew());
    setPlots(Performance.plots());
    setCost(Performance.realCost(c?.costPerUnit ?? 0));
    setAnomalies(Anomalies.all());
    setPriceRows(Performance.priceResponse(c?.costPerUnit ?? 0));
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
                onPress={() => navigation.navigate("CropDetail", { cropId: p.cropId })}
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

      {new Set(priceRows.map((r) => r.price)).size >= 2 && (
        <Card mode="elevated" style={styles.card}>
          <Card.Title title={t("perf.price")} subtitle={t("perf.priceSub")} />
          <Card.Content style={{ paddingHorizontal: 0 }}>
            {priceRows.map((r, i) => {
              const prev = i > 0 ? priceRows[i - 1] : null;
              const dPrice = prev ? r.price - prev.price : 0;
              const dKg = prev ? r.kgPerDay - prev.kgPerDay : 0;
              return (
                <View key={r.week}>
                  {i > 0 && <Divider />}
                  <List.Item
                    title={formatWeekRange(r.week, lang)}
                    description={`${formatMoney(r.price)}/${unit} · ${t("perf.pickers", {
                      n: r.pickers,
                    })}`}
                    right={() => (
                      <View style={styles.priceCell}>
                        <Text variant="titleSmall">
                          {formatNumber(Math.round(r.kgPerDay * 10) / 10)} {unit}
                        </Text>
                        {!!prev && dPrice !== 0 && (
                          <Text
                            variant="labelSmall"
                            style={{ color: dKg > 0 ? "#1b5e20" : "#8a5a00" }}
                          >
                            {dPrice > 0 ? "↑" : "↓"}
                            {formatMoney(Math.abs(dPrice))} · {dKg > 0 ? "+" : ""}
                            {formatNumber(Math.round(dKg * 10) / 10)}
                          </Text>
                        )}
                      </View>
                    )}
                  />
                </View>
              );
            })}
            {(() => {
              // The current week is still running, so its total will always
              // look smaller than a finished one. A week that has not ended
              // cannot support a conclusion, so it is shown but not judged.
              const thisMonday = mondayOf(new Date());
              const rises = priceRows
                .map((r, i) => (i > 0 ? { r, prev: priceRows[i - 1] } : null))
                .filter(
                  (x): x is NonNullable<typeof x> =>
                    !!x && x.r.price > x.prev.price && x.r.week < thisMonday,
                );
              if (!rises.length) return null;
              // Total harvest is the outcome that matters. Judging only by kg
              // per person would call a rise a failure precisely when it
              // worked: new pickers join, they produce less at first, the
              // average per head drops while the crop actually goes up.
              const moreCrop = rises.filter((x) => x.r.kg > x.prev.kg).length;
              const morePerHead = rises.filter((x) => x.r.kgPerDay > x.prev.kgPerDay).length;
              const one = rises.length === 1;
              const key =
                moreCrop === 0
                  ? one
                    ? "perf.priceNoGain.one"
                    : "perf.priceNoGain.other"
                  : moreCrop > morePerHead
                    ? "perf.priceMoreHands"
                    : one
                      ? "perf.priceGain.one"
                      : "perf.priceGain.other";
              return (
                <Text variant="labelSmall" style={[styles.dim, styles.note]}>
                  {t(key, { n: moreCrop || rises.length, total: rises.length })}
                </Text>
              );
            })()}
          </Card.Content>
        </Card>
      )}

      {anomalies.length > 0 && (
        <Card mode="elevated" style={styles.card}>
          <Card.Title title={t("perf.review")} />
          <Card.Content style={{ paddingHorizontal: 0 }}>
            {anomalies.map((a, i) => (
              <View key={a.pickupId}>
                {i > 0 && <Divider />}
                <List.Item
                  onPress={() => {
                    setReview(a);
                    setNewWeight(String(a.weight));
                  }}
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
      <Portal>
        <Dialog visible={!!review} onDismiss={() => setReview(null)}>
          <Dialog.Title>{t("perf.reviewOne")}</Dialog.Title>
          <Dialog.Content style={{ gap: 12 }}>
            <Text variant="bodyMedium">
              {review
                ? t("perf.reviewBody", {
                    weight: `${formatNumber(review.weight)} ${unit}`,
                    person: review.person,
                    reason: t(`perf.rule.${review.rule}`, { n: review.reference }),
                  })
                : ""}
            </Text>
            <TextInput
              mode="outlined"
              label={t("perf.newWeight", { unit })}
              keyboardType="decimal-pad"
              value={newWeight}
              onChangeText={setNewWeight}
            />
          </Dialog.Content>
          <Dialog.Actions style={styles.reviewActions}>
            <Button onPress={() => setReview(null)}>{t("perf.keep")}</Button>
            <Button
              textColor="#b3261e"
              onPress={() => {
                if (!review) return;
                try {
                  Pickups.remove(review.pickupId);
                  setReview(null);
                  load();
                  setSnack(t("perf.discarded"));
                } catch (e) {
                  setReview(null);
                  setSnack(String(e).includes("SETTLED") ? t("perf.settled") : t("pay.error"));
                }
              }}
            >
              {t("perf.discard")}
            </Button>
            <Button
              mode="contained"
              onPress={() => {
                if (!review) return;
                try {
                  Pickups.setWeight(review.pickupId, Number(newWeight.replace(",", ".")));
                  setReview(null);
                  load();
                  setSnack(t("perf.corrected"));
                } catch (e) {
                  setReview(null);
                  setSnack(String(e).includes("SETTLED") ? t("perf.settled") : t("pay.error"));
                }
              }}
            >
              {t("perf.correct")}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar visible={!!snack} onDismiss={() => setSnack("")} duration={5000}>
        {snack}
      </Snackbar>
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
  priceCell: { alignItems: "flex-end", alignSelf: "center" },
  ruleChip: { alignSelf: "center", backgroundColor: "#fdf5e6" },
  ruleText: { fontSize: 11 },
  reviewActions: { flexWrap: "wrap", gap: 4 },
});
