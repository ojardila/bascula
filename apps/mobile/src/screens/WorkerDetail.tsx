import { useCallback, useState } from "react";
import { ScrollView, View, StyleSheet, Dimensions } from "react-native";
import { Text, Card, Avatar, List, Divider, Chip, Button } from "react-native-paper";
import { LineChart } from "react-native-chart-kit";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import {
  People,
  WorkerReports,
  Config,
  Payments,
  fromCents,
  type Person,
  type CropConfig,
} from "../db";
import { useT, formatDay } from "../i18n";
import { useSync } from "../sync/SyncProvider";
import { balanceDisplay, type BalanceDisplay } from "../balanceDisplay.ts";

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
  navigation,
}: NativeStackScreenProps<RootStackParamList, "WorkerDetail">) {
  const { t, lang, money, num } = useT();
  const { status } = useSync();
  const { personId } = route.params;
  const [person, setPerson] = useState<Person | null>(null);
  const [stats, setStats] = useState({ kg: 0, pickups: 0, days: 0, firstDate: "", lastDate: "" });
  const [byWeek, setByWeek] = useState<{ label: string; kg: number }[]>([]);
  const [byCrop, setByCrop] = useState<{ label: string; kg: number }[]>([]);
  const [recent, setRecent] = useState<
    { id: number; weight: number; date: string; crop: string }[]
  >([]);
  // What is actually owed, from the ledger. The gross value of everything
  // ever harvested is a different number and must not be labelled "to pay":
  // it keeps showing a debt for someone who was already paid in full.
  // Decision 7 and §2.2: on a phone that has heard from the server this is the
  // WHOLE balance, jornales and contracts included, even though the breakdown
  // below it can only account for the weighings. A tile that showed half of
  // what somebody is owed, with no way for the reader to know, is the lie that
  // decision was written to stop. On a phone that has never synced it is
  // exactly the number it always was.
  /**
   * Null until the first read. The tile used to hold a bare `0`, which meant
   * "loading", "the account is settled" and "this phone has never heard a
   * balance" all rendered as «Le debemos $0». See `balanceDisplay.ts`.
   */
  const [balance, setBalance] = useState<BalanceDisplay | null>(null);
  const [config, setConfig] = useState<CropConfig | null>(null);

  useFocusEffect(
    useCallback(() => {
      const found = People.byId(personId) ?? null;
      setPerson(found);
      if (found) {
        navigation.setOptions({ title: `${found.name} ${found.lastName}`.trim() });
      }
      const s = WorkerReports.stats(personId);
      if (s) setStats(s);
      setByWeek(WorkerReports.byWeek(personId));
      setByCrop(WorkerReports.byCrop(personId));
      setRecent(WorkerReports.recent(personId));
      const c = Config.get();
      setConfig(c ?? null);
      setBalance(balanceDisplay(Payments.fullBalance(personId), status.pending, status.registered));
    }, [personId, status.pending, status.registered]),
  );

  const unit = config?.unit || "kg";
  const days = stats.days;
  const perDay = stats.days ? stats.kg / stats.days : 0;

  const weekAsc = [...byWeek].reverse();
  const hasChart = weekAsc.length >= 2;
  const chartData = {
    labels: weekAsc.map((r) => formatDay(r.label, lang)),
    datasets: [{ data: weekAsc.map((r) => Math.round(r.kg)) }],
  };
  const cropMax = Math.max(1, ...byCrop.map((c) => c.kg));

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Button
        mode="contained-tonal"
        icon="cash-multiple"
        style={styles.account}
        contentStyle={styles.tall}
        onPress={() => navigation.navigate("Account", { personId })}
      >
        {t("pay.account")}
      </Button>

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
        <Stat label={t("reports.total", { unit })} value={num(stats.kg)} />
        <Stat label={t("reports.pickups")} value={String(stats.pickups)} />
        <Stat label={t("worker.perDay", { unit })} value={num(Math.round(perDay * 10) / 10)} />
        <Stat label={t("worker.days")} value={String(days)} />
        {/* A figure this phone did not derive. It is shown with the day it
            was true ON THE TILE, because a balance without its age is a
            rumour, and «no lo sé» is a different tile from «$0». */}
        <Stat
          label={
            balance === null || balance.state === "unknown"
              ? t("pay.balanceTitle")
              : balance.cents < 0
                ? t("pay.owesUs")
                : t("pay.weOwe")
          }
          value={
            balance === null || balance.state === "unknown"
              ? t("pay.balanceUnknownShort")
              : money(fromCents(Math.abs(balance.cents)))
          }
          sub={
            balance === null || balance.state === "local"
              ? // Derived here, now. Nothing to date.
                undefined
              : balance.state === "unknown"
                ? t("pay.balanceUnknownWhy")
                : balance.state === "provisional"
                  ? t("pay.asOfProvisional", {
                      when: formatDay(balance.at.slice(0, 10), lang),
                      n: num(balance.pending),
                    })
                  : t("pay.asOf", { when: formatDay(balance.at.slice(0, 10), lang) })
          }
          highlight
        />
      </View>

      {/* Which part of it the kilos below cannot explain. Without this line
          the tile is a number the rest of the screen does not add up to. */}
      {balance !== null &&
        (balance.state === "known" || balance.state === "provisional") &&
        balance.notItemisableCents !== 0 && (
        <Text style={styles.notItemisable}>
          {t("pay.notItemisable", {
            amount: money(fromCents(Math.abs(balance.notItemisableCents))),
          })}
        </Text>
      )}

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
                  {num(c.kg)} {unit}
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
                  title={`${num(r.weight)} ${unit} · ${r.crop}`}
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


function Stat({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  /**
   * The line that qualifies the number, rendered inside the tile so it cannot
   * be separated from it by a scroll. The balance tile uses it for the day the
   * figure was true; §7.3 wants the age next to the amount, not above it.
   */
  sub?: string;
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
        {!!sub && (
          <Text variant="labelSmall" style={{ opacity: 0.6, textAlign: "center" }}>
            {sub}
          </Text>
        )}
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  notItemisable: { opacity: 0.78, paddingHorizontal: 12, paddingBottom: 8, lineHeight: 18 },
  container: { padding: 16, gap: 14 },
  account: { marginBottom: 12, borderRadius: 12 },
  tall: { height: 52 },
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
