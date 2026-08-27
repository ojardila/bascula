import { useCallback, useState } from "react";
import { View, ScrollView, StyleSheet } from "react-native";
import { Text, Card, List, Divider, Button, Snackbar } from "react-native-paper";
import { useFocusEffect, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList } from "../types";
import {
  People as PeopleDb,
  Payments,
  fromCents,
  type Balance,
  type LedgerEntry,
  type Person,
} from "../db";
import { useT, formatMoney, formatDay } from "../i18n";

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

  function payOutCredit() {
    if (credit <= 0) return;
    Payments.pay(personId, credit, { method: "efectivo", note: t("pay.deliverCredit") });
    load();
    setSnack(t("pay.success", { amount: formatMoney(fromCents(credit)), name: person?.name ?? "" }));
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text variant="titleLarge" style={styles.name}>
          {person ? `${person.name} ${person.lastName}`.trim() : ""}
        </Text>

        {/* Credit is the worker's money held by the farm, so it never reads as
            debt: its own colour, a word, and no minus sign. */}
        <Card mode="outlined" style={[styles.card, credit > 0 && styles.creditCard]}>
          <Card.Content>
            <Text variant="labelLarge" style={credit > 0 ? styles.creditText : styles.dim}>
              {t("pay.balanceTitle")}
            </Text>
            <Text variant="displaySmall" style={credit > 0 ? styles.creditBig : styles.zeroBig}>
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
            ) : (
              <Text style={styles.dim}>{t("pay.noCredit")}</Text>
            )}
          </Card.Content>
        </Card>

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
