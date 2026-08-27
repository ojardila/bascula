import { useCallback, useMemo, useRef, useState } from "react";
import { View, ScrollView, StyleSheet } from "react-native";
import {
  Text,
  Card,
  Button,
  TextInput,
  SegmentedButtons,
  Chip,
  Divider,
  Snackbar,
} from "react-native-paper";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import {
  Config,
  People as PeopleDb,
  Payments,
  fromCents,
  toCents,
  type CropConfig,
  type Person,
  type SettlementPreview,
} from "../db";
import { useT, formatMoney, formatNumber, formatWeekRange } from "../i18n";

const DAY = 86400000;
const endOfWeek = (monday: string) =>
  new Date(new Date(`${monday}T00:00:00Z`).getTime() + 6 * DAY).toISOString().slice(0, 10);

// Digits only, so a stray "." or "," can't turn 50000 into 50.
const onlyDigits = (s: string) => s.replace(/[^0-9]/g, "");

export default function PayWorker() {
  const { t, lang } = useT();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { personId, monday } = useRoute<RouteProp<RootStackParamList, "PayWorker">>().params;

  const [config, setConfig] = useState<CropConfig | null>(null);
  const [person, setPerson] = useState<Person | null>(null);
  const [preview, setPreview] = useState<SettlementPreview | null>(null);
  const [creditCents, setCreditCents] = useState(0);
  const [mode, setMode] = useState<"full" | "part">("full");
  const [amount, setAmount] = useState("");
  const [snack, setSnack] = useState("");

  const load = useCallback(() => {
    const c = Config.get();
    setConfig(c);
    setPerson(PeopleDb.byId(personId) ?? null);
    if (c) setPreview(Payments.preview(personId, "1970-01-01", endOfWeek(monday), c.costPerUnit));
    setCreditCents(Payments.balance(personId).balanceCents);
  }, [personId, monday]);
  useFocusEffect(load);

  const unit = config?.unit ?? "";
  // What the worker takes home: this period's harvest plus their balance —
  // signed. A negative balance is an advance already handed over, so it must
  // reduce the payout; clamping it to zero would gift the advance away every
  // single week, and the debt would never be consumed.
  const dueCents = Math.max((preview?.grossCents ?? 0) + creditCents, 0);
  const typedCents = toCents(Number(onlyDigits(amount) || 0));
  const payCents = mode === "full" ? dueCents : Math.min(typedCents, dueCents);
  const restCents = dueCents - payCents;

  const byCrop = useMemo(() => {
    const m = new Map<string, { kg: number; cents: number }>();
    for (const i of preview?.items ?? []) {
      const k = i.week;
      const cur = m.get(k) ?? { kg: 0, cents: 0 };
      cur.kg += i.weight;
      cur.cents += i.amountCents;
      m.set(k, cur);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [preview]);

  // Guards the double tap that is normal in the field, with gloves on: without
  // it the second tap finds nothing left to settle but pays a second time.
  const busy = useRef(false);

  function confirm() {
    if (busy.current || !config || !preview || payCents <= 0) return;
    busy.current = true;
    try {
      // Settle first so the earning is on the books, then pay what the ledger
      // actually says is owed — never the amount the screen was showing.
      Payments.settle(personId, "1970-01-01", endOfWeek(monday), config.costPerUnit);
      const owed = Payments.balance(personId).balanceCents;
      const toPay = mode === "full" ? owed : Math.min(typedCents, owed);
      if (toPay <= 0) {
        busy.current = false;
        setSnack(t("pay.nothingPending"));
        return;
      }
      Payments.pay(personId, toPay, { method: "efectivo" });
      setSnack(
        t("pay.success", {
          amount: formatMoney(fromCents(toPay)),
          name: person?.name ?? "",
        }),
      );
      setTimeout(() => navigation.goBack(), 900);
    } catch (e) {
      busy.current = false;
      setSnack(t("pay.error"));
    }
  }

  const quick = [
    { label: formatMoney(50000), cents: 5000000 },
    { label: formatMoney(100000), cents: 10000000 },
    { label: t("pay.half"), cents: Math.round(dueCents / 2) },
    { label: t("pay.all"), cents: dueCents },
  ];

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text variant="titleLarge" style={styles.name}>
          {person ? `${person.name} ${person.lastName}`.trim() : ""}
        </Text>
        <Text variant="bodyMedium" style={styles.dim}>
          {formatWeekRange(monday, lang)}
        </Text>

        <Card mode="elevated" style={styles.card}>
          <Card.Title title={t("pay.gross")} />
          <Card.Content>
            {byCrop.length === 0 ? (
              <Text style={styles.dim}>{t("pay.nothingPending")}</Text>
            ) : (
              byCrop.map(([week, v]) => (
                <View key={week} style={styles.row}>
                  <Text variant="bodyMedium">{formatWeekRange(week, lang)}</Text>
                  <Text variant="bodyMedium" style={styles.dim}>
                    {formatNumber(v.kg)} {unit}
                  </Text>
                  <Text variant="titleSmall">{formatMoney(fromCents(v.cents))}</Text>
                </View>
              ))
            )}
            {creditCents !== 0 && (
              <>
                <Divider style={styles.div} />
                <View style={styles.row}>
                  <Text
                    variant="bodyMedium"
                    style={creditCents > 0 ? styles.credit : styles.owes}
                  >
                    {creditCents > 0 ? t("pay.credit") : t("pay.advance")}
                  </Text>
                  <Text
                    variant="titleSmall"
                    style={creditCents > 0 ? styles.credit : styles.owes}
                  >
                    {creditCents > 0 ? "" : "−"}
                    {formatMoney(fromCents(Math.abs(creditCents)))}
                  </Text>
                </View>
              </>
            )}
            <Divider style={styles.div} />
            <View style={styles.row}>
              <Text variant="titleMedium">{t("pay.payToday")}</Text>
              <Text variant="headlineSmall" style={styles.due}>
                {formatMoney(fromCents(dueCents))}
              </Text>
            </View>
          </Card.Content>
        </Card>

        {dueCents > 0 && (
          <Card mode="elevated" style={styles.card}>
            <Card.Content style={{ gap: 12 }}>
              <SegmentedButtons
                value={mode}
                onValueChange={(v) => setMode(v as "full" | "part")}
                buttons={[
                  { value: "full", label: t("pay.payFull"), icon: "cash" },
                  { value: "part", label: t("pay.payPart"), icon: "cash-minus" },
                ]}
              />
              {mode === "part" && (
                <>
                  <TextInput
                    mode="outlined"
                    label={t("pay.amount")}
                    keyboardType="number-pad"
                    value={amount}
                    onChangeText={(v) => setAmount(onlyDigits(v))}
                    left={<TextInput.Affix text="$" />}
                  />
                  <View style={styles.chips}>
                    {quick.map((q) => (
                      <Chip
                        key={q.label}
                        onPress={() => setAmount(String(Math.round(fromCents(q.cents))))}
                        style={styles.chip}
                      >
                        {q.label}
                      </Chip>
                    ))}
                  </View>
                  <Text variant="bodyMedium" style={restCents > 0 ? styles.credit : styles.dim}>
                    {`${t("pay.leaveCredit")}: ${formatMoney(fromCents(restCents))}`}
                  </Text>
                </>
              )}
              <Button
                mode="contained"
                icon="check"
                disabled={payCents <= 0}
                contentStyle={styles.tall}
                style={styles.confirm}
                onPress={confirm}
              >
                {t("pay.confirm")}
              </Button>
              <Button
                mode="text"
                icon="history"
                onPress={() => navigation.navigate("Account", { personId })}
              >
                {t("pay.account")}
              </Button>
            </Card.Content>
          </Card>
        )}
      </ScrollView>

      <Snackbar visible={!!snack} onDismiss={() => setSnack("")} duration={3000}>
        {snack}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 12, paddingBottom: 32 },
  name: { fontWeight: "700" },
  dim: { opacity: 0.65 },
  card: { marginTop: 12 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingVertical: 4 },
  div: { marginVertical: 8 },
  due: { fontWeight: "800", color: "#1b5e20" },
  credit: { color: "#3949ab", fontWeight: "600" },
  owes: { color: "#8a5a00", fontWeight: "600" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { marginRight: 4 },
  confirm: { borderRadius: 12 },
  tall: { height: 56 },
});
