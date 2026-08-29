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
import * as Print from "expo-print";
import { payrollHtml } from "../receiptHtml";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import {
  Config,
  Payments,
  People as PeopleDb,
  WeekReports,
  weekCrops,
  fromCents,
  today,
  type CropConfig,
} from "../db";
import {
  useT,
  formatWeekRange,
  weekTag,
  weekNumber,
  mondayOf,
  endOfWeek,
  EPOCH_START,
} from "../i18n";

const DAY = 86400000;
const shiftWeek = (monday: string, weeks: number) =>
  new Date(new Date(`${monday}T00:00:00Z`).getTime() + weeks * 7 * DAY)
    .toISOString()
    .slice(0, 10);

type Row = { personId: number; name: string; kg: number; amountCents: number };

export default function PaymentsPanel() {
  const { t, lang, money, num } = useT();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [config, setConfig] = useState<CropConfig | null>(null);
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [rows, setRows] = useState<Row[]>([]);
  const [lots, setLots] = useState<{ crop: string; kg: number }[]>([]);
  const [balances, setBalances] = useState<Record<number, number>>({});
  const [credits, setCredits] = useState<{ personId: number; name: string; cents: number }[]>([]);
  const [bulk, setBulk] = useState<Set<number> | null>(null); // null = sheet closed
  const [snack, setSnack] = useState("");
  // What the last bulk run created, so it can be taken back. Paying the whole
  // crew is the one action where a wrong tap costs the most, and undoing it by
  // hand would mean reversing a payment and voiding a settlement per person.
  const [lastRun, setLastRun] = useState<{ payments: number[]; settlements: number[] } | null>(
    null,
  );
  // Paper fires onDismiss when the action is tapped, which would drop lastRun
  // and take the retry away exactly when it is needed.
  const [retry, setRetry] = useState(false);

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
    const pendingIds = new Set(
      Payments.pendingAll(c.costPerUnit, endOfWeek(monday)).map((r) => r.personId),
    );
    setCredits(
      all
        .filter((x) => x.balanceCents > 0 && !pendingIds.has(x.personId))
        .map((x) => ({ personId: x.personId, name: x.name, cents: x.balanceCents })),
    );
  }, [monday]);
  useFocusEffect(load);

  const unit = config?.unit ?? "";

  // What the worker actually takes home: the week's harvest netted against
  // their balance. Showing the gross would promise cash that an advance has
  // already consumed, and the till would not match the confirmation.
  const netOf = useCallback(
    (r: Row) => Math.max(r.amountCents + (balances[r.personId] ?? 0), 0),
    [balances],
  );
  const total = useMemo(
    () => rows.reduce((s, r) => s + netOf(r), 0),
    [rows, netOf],
  );
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
  const selectedTotal = selected.reduce((s, r) => s + netOf(r), 0);

  // Settle then pay, for everyone ticked. Each worker is independent: one
  // failure must not take the rest of the payroll down with it.
  function runBulk() {
    if (!config) return;
    let done = 0;
    let noCash = 0;
    let failed = 0;
    const payments: number[] = [];
    const settlements: number[] = [];
    for (const r of selected) {
      try {
        const res = Payments.settle(r.personId, EPOCH_START, endOfWeek(monday), config.costPerUnit);
        if (!res) {
          noCash++;
          continue;
        }
        // Pay the balance, not the gross: the balance already nets out any
        // advance handed over during the week. Paying the gross would hand the
        // advance over a second time, for the whole payroll at once.
        const owed = Payments.balance(r.personId).balanceCents;
        if (owed <= 0) {
          noCash++;
          continue;
        }
        // Recorded before attempting the payment: settle() has already
        // committed, so if pay() throws the settlement must still be undoable.
        settlements.push(res.settlementId);
        payments.push(Payments.pay(r.personId, owed, { method: "efectivo" }));
        done++;
      } catch {
        failed++; // skip this worker, keep the rest of the payroll going
      }
    }
    setBulk(null);
    setLastRun(done ? { payments, settlements } : null);
    load();
    const extra = [
      noCash ? t("pay.noCashN", { n: noCash }) : "",
      failed ? t("pay.failedN", { n: failed }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    setSnack(`${t("pay.paidTo", { n: done })}${extra ? ` ${extra}` : ""}`);
  }

  // Reverse the payments first, then void the settlements: voiding posts its
  // own reversal of the earning, and doing it the other way round would leave
  // a payment standing against an earning that no longer exists.
  function undoLastRun() {
    if (!lastRun) return;
    try {
      Payments.undoRun(lastRun.payments, lastRun.settlements, t("pay.undo"));
      setLastRun(null);
      load();
      // Deferred: tapping the action also fires onDismiss, which clears the
      // snackbar — setting the text now would be wiped in the same tick.
      setTimeout(() => setSnack(t("pay.undone")), 0);
    } catch {
      // Keep lastRun so the action stays available for a retry: the whole
      // thing rolled back, so nothing is half undone.
      load();
      setTimeout(() => {
        setSnack(t("pay.error"));
        setRetry(true);
      }, 0);
    }
  }

  /** The sheet the office files: one line and one signature per worker. */
  async function printPayroll() {
    if (!config) return;
    const balances = Payments.balances();
    const paidThisWeek = new Map<number, number>();
    for (const b of balances) {
      const hist = Payments.history(b.personId, 50);
      const paid = hist
        .filter((h) => h.kind === "pago" && h.date >= monday)
        .reduce((s, h) => s + Math.abs(h.amountCents), 0);
      if (paid > 0) paidThisWeek.set(b.personId, paid);
    }
    if (!paidThisWeek.size) {
      setSnack(t("pay.emptyHistory"));
      return;
    }
    // From the week's actual work, not from what is still pending: whoever was
    // already paid has no pending row left, and printed as zero kilos.
    const kgOf = new Map(
      WeekReports.byWorker(monday).map((w) => [w.personId, w.kg] as const),
    );
    try {
      await Print.printAsync({
        html: payrollHtml(
          balances
            .filter((b) => paidThisWeek.has(b.personId))
            .map((b) => ({
              name: b.name,
              doc: PeopleDb.byId(b.personId)?.docId ?? null,
              kg: kgOf.get(b.personId) ?? 0,
              paidCents: paidThisWeek.get(b.personId) ?? 0,
              balanceCents: b.balanceCents,
            })),
          {
            title: `${t("pay.payroll")} · ${formatWeekRange(monday, lang)}`,
            farmLabel: config.label,
            unit: config.unit,
            date: today(),
          },
          lang,
        ),
      });
    } catch {
      /* dismissed */
    }
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
              {money(fromCents(total))}
            </Text>
            <Text variant="bodyMedium" style={styles.dim}>
              {num(totalKg)} {unit} · {rows.length === 1 ? t("pay.people.one") : t("pay.people", { n: rows.length })}
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
            <Button
              mode="text"
              icon="printer"
              onPress={printPayroll}
              style={styles.payrollBtn}
            >
              {t("pay.printPayroll")}
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
                        {money(fromCents(c.cents))}
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
                    description={`${num(r.kg)} ${unit}${
                      balances[r.personId] > 0
                        ? ` · ${t("pay.credit")} ${money(fromCents(balances[r.personId]))}`
                        : ""
                    }`}
                    left={() => <Avatar.Icon size={40} icon="account" style={styles.avatar} />}
                    right={() => (
                      <View style={styles.amountCell}>
                        <Text variant="titleSmall">{money(fromCents(netOf(r)))}</Text>
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
                amount: money(fromCents(selectedTotal)),
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

      <Snackbar
        visible={!!snack}
        onDismiss={() => {
          setSnack("");
          if (!retry) setLastRun(null);
          setRetry(false);
        }}
        duration={15000}
        action={lastRun ? { label: t("pay.undo"), onPress: undoLastRun } : undefined}
      >
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
  payrollBtn: { marginTop: 6 },
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
