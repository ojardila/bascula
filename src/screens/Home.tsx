import { useCallback, useState } from "react";
import { ScrollView, View, StyleSheet } from "react-native";
import { Text, Card, Button, List, Divider, TouchableRipple } from "react-native-paper";
import { LinearGradient } from "expo-linear-gradient";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { TabParamList } from "../types";
import { Reports, Pickups, Config } from "../db";
import { useT } from "../i18n";

type Props = BottomTabScreenProps<TabParamList, "Home">;

export default function Home({ navigation }: Props) {
  const { t } = useT();
  const [totals, setTotals] = useState({ pickups: 0, kg: 0, people: 0, crops: 0 });
  const [today, setToday] = useState({ kg: 0, count: 0 });
  const [week, setWeek] = useState({ kg: 0, count: 0 });
  const [unit, setUnit] = useState("kg");
  const [cropLabel, setCropLabel] = useState("");
  const [recent, setRecent] = useState<
    { id: number; weight: number; date: string; person: string; crop: string }[]
  >([]);

  useFocusEffect(
    useCallback(() => {
      const tt = Reports.totals();
      if (tt) setTotals(tt);
      const d = Reports.today();
      if (d) setToday(d);
      const w = Reports.thisWeek();
      if (w) setWeek(w);
      const cfg = Config.get();
      setUnit(cfg?.unit || "kg");
      setCropLabel(cfg?.label || "");
      setRecent(Pickups.recent().slice(0, 4));
    }, []),
  );

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <LinearGradient
        colors={["#33953a", "#1b5e20"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <View style={styles.heroTop}>
          <Text style={styles.heroLabel}>{t("home.totalHarvested")}</Text>
          {!!cropLabel && (
            <View style={styles.cropBadge}>
              <MaterialCommunityIcons name="sprout" size={13} color="#eafbe7" />
              <Text style={styles.cropBadgeText}>{cropLabel}</Text>
            </View>
          )}
        </View>
        <Text style={styles.heroValue}>
          {totals.kg.toLocaleString()}
          <Text style={styles.heroUnit}> {unit}</Text>
        </Text>
        <View style={styles.heroChips}>
          <HeroChip
            icon="calendar-week"
            text={`${t("home.thisWeek")} · ${week.kg.toLocaleString()} ${unit}`}
          />
          <HeroChip
            icon="white-balance-sunny"
            text={`${t("home.today")} · ${today.kg.toLocaleString()} ${unit}`}
          />
          <HeroChip icon="scale" text={t("home.pickupsCount", { n: totals.pickups })} />
        </View>
      </LinearGradient>

      <View style={styles.stats}>
        <Stat
          icon="account-group"
          value={totals.people}
          label={t("label.workers")}
          onPress={() => navigation.navigate("People")}
        />
        <Stat
          icon="sprout"
          value={totals.crops}
          label={t("label.crops")}
          onPress={() => navigation.navigate("Crops")}
        />
        <Stat
          icon="chart-bar"
          value={totals.pickups}
          label={t("label.pickups")}
          onPress={() => navigation.navigate("Reports")}
        />
      </View>

      <Button
        mode="contained"
        icon="scale"
        style={styles.cta}
        contentStyle={styles.ctaContent}
        labelStyle={styles.ctaLabel}
        onPress={() => navigation.navigate("Pickup")}
      >
        {t("home.registerPickup")}
      </Button>

      <Card style={styles.card} mode="elevated">
        <Card.Title
          title={t("home.recentActivity")}
          left={(p) => <MaterialCommunityIcons {...p} name="history" size={24} color="#2e7d32" />}
        />
        <Card.Content style={{ paddingHorizontal: 0 }}>
          {recent.length === 0 ? (
            <Text style={styles.empty}>{t("home.noPickups")}</Text>
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

function HeroChip({ icon, text }: { icon: string; text: string }) {
  return (
    <View style={styles.heroChip}>
      <MaterialCommunityIcons name={icon as any} size={14} color="#fff" />
      <Text style={styles.heroChipText}>{text}</Text>
    </View>
  );
}

function Stat({
  icon,
  value,
  label,
  onPress,
}: {
  icon: string;
  value: number;
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableRipple onPress={onPress} style={styles.stat} borderless>
      <View style={styles.statInner}>
        <View style={styles.statIcon}>
          <MaterialCommunityIcons name={icon as any} size={22} color="#2e7d32" />
        </View>
        <Text variant="titleLarge" style={styles.statValue}>
          {value}
        </Text>
        <Text style={styles.statLabel}>{label}</Text>
      </View>
    </TouchableRipple>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 14 },
  hero: {
    borderRadius: 20,
    padding: 20,
    shadowColor: "#1b5e20",
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },
  heroTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  heroLabel: { color: "#cdeccb", fontSize: 13, fontWeight: "600" },
  heroValue: { color: "#fff", fontSize: 44, fontWeight: "800", marginTop: 4 },
  heroUnit: { fontSize: 20, fontWeight: "700", color: "#cdeccb" },
  heroChips: { flexDirection: "row", gap: 8, marginTop: 12, flexWrap: "wrap" },
  heroChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(255,255,255,0.18)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  heroChipText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  cropBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(255,255,255,0.2)",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  cropBadgeText: { color: "#eafbe7", fontSize: 12, fontWeight: "700" },
  stats: { flexDirection: "row", gap: 10 },
  stat: {
    flex: 1,
    borderRadius: 16,
    backgroundColor: "#fff",
    shadowColor: "#1b5e20",
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  statInner: { alignItems: "center", gap: 5, paddingVertical: 16 },
  statIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "rgba(46,125,50,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  statValue: { fontWeight: "800" },
  statLabel: { fontSize: 12, opacity: 0.6 },
  cta: { borderRadius: 16 },
  ctaContent: { paddingVertical: 8 },
  ctaLabel: { fontSize: 16, fontWeight: "700" },
  card: { borderRadius: 16 },
  empty: { opacity: 0.6, padding: 16 },
});
