import { useCallback, useMemo, useState } from "react";
import { View, ScrollView, StyleSheet } from "react-native";
import {
  Text,
  Card,
  Button,
  List,
  Avatar,
  IconButton,
  Portal,
  Dialog,
  Checkbox,
  Snackbar,
  Divider,
} from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import { Config, Payments, weekCrops, fromCents, type CropConfig } from "../db";
import {
  useT,
  formatMoney,
  formatNumber,
  formatWeekRange,
  weekTag,
  weekNumber,
  mondayOf,
} from "../i18n";

const DAY = 86400000;
const shiftWeek = (monday: string, weeks: number) =>
  new Date(new Date(`${monday}T00:00:00Z`).getTime() + weeks * 7 * DAY)
    .toISOString()
    .slice(0, 10);
// Sunday, not the following Monday: a week ends on day six.
const endOfWeek = (monday: string) =>
  new Date(new Date(`${monday}T00:00:00Z`).getTime() + 6 * DAY).toISOString().slice(0, 10);

type Row = { personId: number; name: string; kg: number; amountCents: number };

export default function PaymentsPanel() {
  const { t, lang } = useT();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [config, setConfig] = useState<CropConfig | null>(null);
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [rows, setRows] = useState<Row[]>([]);
  const [lots, setLots] = useState<{ crop: string; kg: number }[]>([]);
  const [balances, setBalances] = useState<Record<number, number>>({});
  const [credits, setCredits] = useState<{ personId: number; name: string; cents: number }[]>([]);
  const [bulk, setBulk] = useState<Set<number> | null>(null); // null = sheet closed
  const [snack, setSnack] = useState("");

  const load = useCallback(() => {
    const c = Config.get();
    setConfig(c);
    if (!c) return;
    // Everything still owed up to the end of the selected week; already-settled
    // pickups drop out on their own.
    setRows(
      Payments.pendingAll(c.costPerUnit, endOfWeek(monday)).filter(
        (r) => r.amountCents > 0,
      ) as Row[],
    );
    setLots(weekCrops().filter((w) => w.week === monday).map((w) => ({ crop: w.crop, kg: w.kg })));
    const b: Record<number, number> = {};
    const all = Payments.balances();
    for (const x of all) b[x.personId] = x.balanceCents;
    setBalances(b);
    // Workers holding money with the farm. Without this row their savings
    // would vanish from the UI the moment they stop having pending harvest.
    setCredits(
      all
        .filter((x) => x.balanceCents > 0)
        .map((x) => ({ personId: x.personId, name: x.name, cents: x.balanceCents })),
    );
  }, [monday]);
  useFocusEffect(load);

  const unit = config?.unit ?? "";
  const total = useMemo(() => rows.reduce((s, r) => s + r.amountCents, 0), [rows]);
  const totalKg = useMemo(() => rows.reduce((s, r) => s + r.kg, 0), [rows]);

  function openBulk() {
    setBulk(new Set(rows.map((r) => r.personId)));
  }

  function toggle(id: number) {
    setBulk((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const selected = useMemo(
    () => rows.filter((r) => bulk?.has(r.personId)),
    [rows, bulk],
  );
  const selectedTotal = selected.reduce((s, r) => s + r.amountCents, 0);

  // Settle then pay in full, for everyone ticked. Each worker is independent:
  // one failure must not take the rest of the payroll down with it.
  function runBulk() {
    if (!config) return;
    let done = 0;
    for (const r of selected) {
      const res = Payments.settle(r.personId, "1970-01-01", endOfWeek(monday), config.costPerUnit);
      if (res) {
        Payments.pay(r.personId, res.grossCents, { method: "efectivo" });
        done++;
      }
    }
    setBulk(null);
    load();
    setSnack(t("pay.paidTo", { n: done }));
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.weekBar}>
          <IconButton icon="chevron-left" onPress={() => setMonday(shiftWeek(monday, -1))} />
          <View style={styles.weekLabel}>
            <Text variant="titleMedium">{formatWeekRange(monday, lang)}</Text>
            <Text variant="labelSmall" style={styles.dim}>
              {weekTag(monday, lang) ?? t("week.short", { n: weekNumber(monday) })}
            </Text>
          </View>
          <IconButton
            icon="chevron-right"
            disabled={monday >= mondayOf(new Date())}
            onPress={() => setMonday(shiftWeek(monday, 1))}
          />
        </View>

        {lots.length > 0 && (
          <Text variant="labelSmall" style={[styles.dim, styles.lots]}>
            {lots.map((l) => l.crop).join(" · ")}
          </Text>
        )}

        <Card mode="elevated" style={styles.card}>
          <Card.Content>
            <Text variant="labelLarge" style={styles.dim}>
              {t("pay.toPay")}
            </Text>
            <Text variant="displaySmall" style={styles.total}>
              {formatMoney(fromCents(total))}
            </Text>
            <Text variant="bodyMedium" style={styles.dim}>
              {formatNumber(totalKg)} {unit} · {t("pay.people", { n: rows.length })}
            </Text>
            <Button
              mode="contained"
              icon="cash-multiple"
              disabled={!rows.length}
              onPress={openBulk}
              style={styles.payAll}
              contentStyle={styles.tall}
            >
              {t("pay.payAll")}
            </Button>
          </Card.Content>
        </Card>

        {credits.length > 0 && (
          <Card mode="outlined" style={[styles.card, styles.creditCard]}>
            <Card.Content style={{ paddingHorizontal: 0 }}>
              <Text variant="labelLarge" style={styles.creditTitle}>
                {t("pay.credit")}
              </Text>
              {credits.map((c, i) => (
                <View key={c.personId}>
                  {i > 0 && <Divider />}
                  <List.Item
                    onPress={() => navigation.navigate("Account", { personId: c.personId })}
                    title={c.name}
                    left={() => (
                      <Avatar.Icon
                        size={36}
                        icon="piggy-bank-outline"
                        style={styles.creditAvatar}
                        color="#fff"
                      />
                    )}
                    right={() => (
                      <Text variant="titleSmall" style={styles.creditAmount}>
                        {formatMoney(fromCents(c.cents))}
                      </Text>
                    )}
                  />
                </View>
              ))}
            </Card.Content>
          </Card>
        )}

        {rows.length === 0 ? (
          <Text style={styles.empty}>{t("pay.empty")}</Text>
        ) : (
          <Card mode="elevated" style={styles.card}>
            <Card.Content style={{ paddingHorizontal: 0 }}>
              {rows.map((r, i) => (
                <View key={r.personId}>
                  {i > 0 && <Divider />}
                  <List.Item
                    onPress={() =>
                      navigation.navigate("PayWorker", { personId: r.personId, monday })
                    }
                    title={r.name}
                    description={`${formatNumber(r.kg)} ${unit}${
                      balances[r.personId] > 0
                        ? ` · ${t("pay.credit")} ${formatMoney(fromCents(balances[r.personId]))}`
                        : ""
                    }`}
                    left={() => <Avatar.Icon size={40} icon="account" style={styles.avatar} />}
                    right={() => (
                      <View style={styles.amountCell}>
                        <Text variant="titleSmall">{formatMoney(fromCents(r.amountCents))}</Text>
                        <MaterialCommunityIcons name="chevron-right" size={18} color="#9aa39a" />
                      </View>
                    )}
                  />
                </View>
              ))}
            </Card.Content>
          </Card>
        )}
      </ScrollView>

      <Portal>
        <Dialog visible={bulk !== null} onDismiss={() => setBulk(null)}>
          <Dialog.Title>{t("pay.payAll")}</Dialog.Title>
          <Dialog.ScrollArea style={styles.sheet}>
            <ScrollView>
              {rows.map((r) => (
                <Checkbox.Item
                  key={r.personId}
                  label={r.name}
                  labelStyle={styles.checkLabel}
                  status={bulk?.has(r.personId) ? "checked" : "unchecked"}
                  onPress={() => toggle(r.personId)}
                />
              ))}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {t("pay.askMany", {
                amount: formatMoney(fromCents(selectedTotal)),
                n: selected.length,
              })}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setBulk(null)}>{t("pay.notNow")}</Button>
            <Button mode="contained" disabled={!selected.length} onPress={runBulk}>
              {t("pay.yes")}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar visible={!!snack} onDismiss={() => setSnack("")} duration={4000}>
        {snack}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 12, paddingBottom: 32 },
  weekBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  weekLabel: { alignItems: "center" },
  dim: { opacity: 0.65 },
  lots: { textAlign: "center", marginBottom: 8 },
  card: { marginBottom: 12 },
  total: { fontWeight: "800", color: "#1b5e20", marginVertical: 2 },
  payAll: { marginTop: 14, borderRadius: 12 },
  tall: { height: 56 },
  avatar: { alignSelf: "center", marginLeft: 8 },
  amountCell: { flexDirection: "row", alignItems: "center", gap: 4 },
  empty: { opacity: 0.6, textAlign: "center", padding: 24 },
  creditCard: { borderColor: "#3949ab", backgroundColor: "#eef0fb" },
  creditTitle: { color: "#3949ab", paddingHorizontal: 16, paddingBottom: 4 },
  creditAvatar: { alignSelf: "center", marginLeft: 8, backgroundColor: "#3949ab" },
  creditAmount: { color: "#3949ab", fontWeight: "700", alignSelf: "center" },
  sheet: { maxHeight: 280, paddingHorizontal: 0 },
  checkLabel: { fontSize: 15 },
});
