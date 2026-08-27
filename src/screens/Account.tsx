import { useCallback, useRef, useState } from "react";
import { View, ScrollView, StyleSheet, Share } from "react-native";
import { Text, Card, List, Divider, Button, Snackbar } from "react-native-paper";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList } from "../types";
import {
  People as PeopleDb,
  Payments,
  Config,
  fromCents,
  type Balance,
  type LedgerEntry,
  type Person,
} from "../db";
import { useT, formatMoney, formatDay } from "../i18n";
import { buildReceipt } from "../receipt";

const ICON: Record<string, string> = {
  devengo: "scale-balance",
  pago: "cash",
  anticipo: "cash-fast",
  deduccion: "cart-minus",
  ajuste: "tune",
  reverso: "undo-variant",
};

export default function Account() {
  const { t, lang } = useT();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { personId } = useRoute<RouteProp<RootStackParamList, "Account">>().params;
  const [person, setPerson] = useState<Person | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [snack, setSnack] = useState("");

  const load = useCallback(() => {
    setPerson(PeopleDb.byId(personId) ?? null);
    setBalance(Payments.balance(personId));
    setRows(Payments.history(personId));
  }, [personId]);
  useFocusEffect(load);

  const credit = balance?.balanceCents ?? 0;
  const owes = credit < 0; // the worker took an advance that is not worked off yet
  const busy = useRef(false);

  function payOutCredit() {
    if (busy.current || credit <= 0) return;
    busy.current = true;
    try {
      Payments.pay(personId, credit, { method: "efectivo", note: t("pay.deliverCredit") });
      load();
      setSnack(
        t("pay.success", { amount: formatMoney(fromCents(credit)), name: person?.name ?? "" }),
      );
    } catch {
      setSnack(t("pay.error"));
    }
    busy.current = false;
  }

  // Plain text so it lands readable in the chat itself; the per-week breakdown
  // is the point, because the worker cannot verify a weight after the fact.
  async function share() {
    const cfg = Config.get();
    const settlements = Payments.settlements(personId);
    const items = settlements[0] ? Payments.itemsOf(settlements[0].id) : [];
    const paid = rows.find((r) => r.kind === "pago");
    const text = buildReceipt(
      {
        workerName: person ? `${person.name} ${person.lastName}`.trim() : "",
        farmLabel: cfg?.label ?? "",
        unit: cfg?.unit ?? "",
        monday: settlements[0]?.periodStart ?? "",
        items,
        paidCents: paid ? Math.abs(paid.amountCents) : 0,
        balance: balance ?? {
          personId, earnedCents: 0, paidCents: 0, deductedCents: 0,
          balanceCents: 0, lastMovementAt: null,
        },
        date: new Date().toISOString().slice(0, 10),
      },
      lang,
    );
    try {
      await Share.share({ message: text });
    } catch {
      setSnack(t("pay.error"));
    }
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text variant="titleLarge" style={styles.name}>
          {person ? `${person.name} ${person.lastName}`.trim() : ""}
        </Text>

        {/* Credit is the worker's money held by the farm, so it never reads as
            debt: its own colour, a word, and no minus sign. */}
        <Card
          mode="outlined"
          style={[styles.card, credit > 0 && styles.creditCard, owes && styles.owesCard]}
        >
          <Card.Content>
            <Text
              variant="labelLarge"
              style={credit > 0 ? styles.creditText : owes ? styles.owesText : styles.dim}
            >
              {credit > 0 ? t("pay.balanceTitle") : owes ? t("pay.owesUs") : t("pay.balanceTitle")}
            </Text>
            <Text
              variant="displaySmall"
              style={credit > 0 ? styles.creditBig : owes ? styles.owesBig : styles.zeroBig}
            >
              {formatMoney(fromCents(Math.abs(credit)))}
            </Text>
            {credit > 0 ? (
              <Button
                mode="contained-tonal"
                icon="hand-coin"
                onPress={payOutCredit}
                style={styles.action}
                contentStyle={styles.tall}
              >
                {t("pay.deliverCredit")}
              </Button>
            ) : owes ? (
              <Text style={styles.owesText}>{t("pay.owesUsBody")}</Text>
            ) : (
              <Text style={styles.dim}>{t("pay.noCredit")}</Text>
            )}
          </Card.Content>
        </Card>

        <View style={styles.actions}>
          <Button
            mode="contained-tonal"
            icon="cash-fast"
            style={styles.half}
            contentStyle={styles.tall}
            onPress={() => navigation.navigate("Adjust", { personId, kind: "anticipo" })}
          >
            {t("pay.newMovement")}
          </Button>
          <Button
            mode="outlined"
            icon="share-variant"
            style={styles.half}
            contentStyle={styles.tall}
            disabled={rows.length === 0}
            onPress={share}
          >
            {t("pay.share")}
          </Button>
        </View>

        <Card mode="elevated" style={styles.card}>
          <Card.Title title={t("pay.movements")} />
          <Card.Content style={{ paddingHorizontal: 0 }}>
            {rows.length === 0 ? (
              <Text style={styles.empty}>{t("pay.emptyHistory")}</Text>
            ) : (
              rows.map((e, i) => (
                <View key={e.id}>
                  {i > 0 && <Divider />}
                  <List.Item
                    title={t(`pay.kind.${e.kind}`)}
                    description={`${formatDay(e.date, lang)}${e.note ? ` · ${e.note}` : ""}`}
                    left={(p) => <List.Icon {...p} icon={ICON[e.kind] ?? "circle-small"} />}
                    right={() => (
                      <Text
                        variant="titleSmall"
                        style={e.amountCents > 0 ? styles.plus : styles.minus}
                      >
                        {e.amountCents > 0 ? "+" : "−"}
                        {formatMoney(fromCents(Math.abs(e.amountCents)))}
                      </Text>
                    )}
                  />
                </View>
              ))
            )}
          </Card.Content>
        </Card>
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
  name: { fontWeight: "700", marginBottom: 4 },
  card: { marginTop: 12 },
  creditCard: { borderColor: "#3949ab", backgroundColor: "#eef0fb" },
  owesCard: { borderColor: "#8a5a00", backgroundColor: "#fdf5e6" },
  owesText: { color: "#8a5a00" },
  owesBig: { color: "#8a5a00", fontWeight: "800", marginVertical: 4 },
  actions: { flexDirection: "row", gap: 8, marginTop: 12 },
  half: { flex: 1, borderRadius: 12 },
  creditText: { color: "#3949ab" },
  creditBig: { color: "#3949ab", fontWeight: "800", marginVertical: 4 },
  zeroBig: { opacity: 0.35, fontWeight: "800", marginVertical: 4 },
  dim: { opacity: 0.65 },
  action: { marginTop: 10, borderRadius: 12 },
  tall: { height: 52 },
  empty: { opacity: 0.6, textAlign: "center", padding: 20 },
  plus: { color: "#1b5e20", alignSelf: "center", fontWeight: "700" },
  minus: { opacity: 0.75, alignSelf: "center", fontWeight: "700" },
});
