import { useCallback, useRef, useState } from "react";
import { View, ScrollView, StyleSheet } from "react-native";
import { Text, Card, Button, TextInput, SegmentedButtons, Chip, Snackbar, Portal, Dialog } from "react-native-paper";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import { People as PeopleDb, Payments, fromCents, toCents, today, type Person } from "../db";
import { useT } from "../i18n";
import { printAdvance } from "../printAdvance.ts";

// Typed deductions instead of free text: these five cover what actually comes
// out of a picker's pay on a farm, and naming them keeps the history readable
// and comparable across workers.
const DISCOUNTS = [
  { key: "food", icon: "silverware-fork-knife" },
  { key: "lodging", icon: "bed" },
  { key: "tools", icon: "hammer-wrench" },
  { key: "store", icon: "storefront" },
  { key: "other", icon: "dots-horizontal" },
];

const onlyDigits = (s: string) => s.replace(/[^0-9]/g, "");

export default function Adjust() {
  const { t, lang, money } = useT();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { personId, kind } = useRoute<RouteProp<RootStackParamList, "Adjust">>().params;

  const [person, setPerson] = useState<Person | null>(null);
  const [balanceCents, setBalanceCents] = useState(0);
  const [mode, setMode] = useState<"anticipo" | "deduccion">(kind);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("food");
  // "Other" is a catch-all, so it needs a name written in or the history reads
  // as a column of identical "Other" lines nobody can tell apart later.
  const [otherLabel, setOtherLabel] = useState("");
  const [snack, setSnack] = useState("");
  const [asking, setAsking] = useState(false);

  const load = useCallback(() => {
    setPerson(PeopleDb.byId(personId) ?? null);
    setBalanceCents(Payments.balance(personId).balanceCents);
  }, [personId]);
  useFocusEffect(load);

  const cents = toCents(Number(onlyDigits(amount) || 0));
  const after = balanceCents - cents;

  // Nothing on screen changes after the first tap here — the amount stays put
  // and the button stays enabled — so this is the easiest of the three buttons
  // to fire twice and the only one that would create a duplicate advance.
  const busy = useRef(false);

  function save() {
    if (busy.current || cents <= 0) return;
    busy.current = true;
    try {
      if (mode === "anticipo") {
        Payments.advance(personId, cents);
        setSnack(t("pay.saved"));
        // The voucher, printed after the row is on the books and never before.
        // This is the screen an advance is normally handed over from, and
        // until now it sent the worker away with nothing on paper — the one
        // part of §6.2's promise the app did not keep. When settling leaves
        // the handset it becomes the ONLY document a worker can be given in
        // the lote, so it is not a nicety.
        void printAdvance(personId, cents, today(), lang).then(() => navigation.goBack());
        return;
      }
      const label =
        reason === "other" && otherLabel.trim() ? otherLabel.trim() : t(`disc.${reason}`);
      // A deduction is money NOT handed over. There is nothing to sign for and
      // no cash leaves anybody's hand, so it prints nothing.
      Payments.deduct(personId, cents, label);
      setSnack(t("pay.saved"));
      setTimeout(() => navigation.goBack(), 700);
    } catch {
      busy.current = false;
      setSnack(t("pay.error"));
    }
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text variant="titleLarge" style={styles.name}>
          {person ? `${person.name} ${person.lastName}`.trim() : ""}
        </Text>

        <Card mode="elevated" style={styles.card}>
          <Card.Content style={{ gap: 12 }}>
            <SegmentedButtons
              value={mode}
              onValueChange={(v) => setMode(v as "anticipo" | "deduccion")}
              buttons={[
                { value: "anticipo", label: t("pay.advance"), icon: "cash-fast" },
                { value: "deduccion", label: t("pay.discounts"), icon: "cart-minus" },
              ]}
            />

            {mode === "deduccion" && (
              <View style={styles.chips}>
                {DISCOUNTS.map((d) => (
                  <Chip
                    key={d.key}
                    icon={d.icon}
                    selected={reason === d.key}
                    showSelectedOverlay
                    onPress={() => setReason(d.key)}
                    style={styles.chip}
                  >
                    {t(`disc.${d.key}`)}
                  </Chip>
                ))}
              </View>
            )}

            {mode === "deduccion" && reason === "other" && (
              <TextInput
                mode="outlined"
                label={t("disc.otherLabel")}
                placeholder={t("disc.otherHint")}
                value={otherLabel}
                onChangeText={setOtherLabel}
                maxLength={40}
              />
            )}

            <TextInput
              mode="outlined"
              label={t("pay.amount")}
              keyboardType="number-pad"
              value={amount}
              onChangeText={(v) => setAmount(onlyDigits(v))}
              left={<TextInput.Affix text="$" />}
            />

            <View style={styles.summary}>
              <Text variant="bodyMedium" style={styles.dim}>
                {t("pay.credit")}: {money(fromCents(balanceCents))}
              </Text>
              <Text variant="bodyMedium" style={after < 0 ? styles.negative : styles.credit}>
                {t("pay.afterwards")}: {money(fromCents(after))}
              </Text>
            </View>

            <Button
              mode="contained"
              icon="check"
              disabled={cents <= 0 || (mode === "deduccion" && reason === "other" && !otherLabel.trim())}
              contentStyle={styles.tall}
              style={styles.save}
              onPress={() => setAsking(true)}
            >
              {t("pay.saveMovement")}
            </Button>
          </Card.Content>
        </Card>
      </ScrollView>

      <Portal>
        <Dialog visible={asking} onDismiss={() => setAsking(false)}>
          <Dialog.Title>{t("pay.saveMovement")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {mode === "anticipo"
                ? t("pay.askAdvance", {
                    amount: money(fromCents(cents)),
                    name: person?.name ?? "",
                  })
                : `${person ? `${person.name} ${person.lastName}`.trim() : ""} · ${money(fromCents(cents))}`}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAsking(false)}>{t("pay.notNow")}</Button>
            <Button
              mode="contained"
              onPress={() => {
                setAsking(false);
                save();
              }}
            >
              {t("pay.yes")}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar visible={!!snack} onDismiss={() => setSnack("")} duration={2500}>
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
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { marginRight: 4 },
  summary: { gap: 2 },
  dim: { opacity: 0.78 },
  credit: { color: "#3949ab", fontWeight: "600" },
  negative: { color: "#8a5a00", fontWeight: "600" },
  save: { borderRadius: 12 },
  tall: { height: 56 },
});
