import { useCallback, useRef, useState } from "react";
import { View, ScrollView, StyleSheet } from "react-native";
import { Text, Card, Button, TextInput, SegmentedButtons, Chip, Snackbar } from "react-native-paper";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import { People as PeopleDb, Payments, fromCents, toCents, type Person } from "../db";
import { useT, formatMoney } from "../i18n";

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
  const { t } = useT();
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
      } else {
        const label =
          reason === "other" && otherLabel.trim()
            ? otherLabel.trim()
            : t(`disc.${reason}`);
        Payments.deduct(personId, cents, label);
      }
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
                {t("pay.credit")}: {formatMoney(fromCents(balanceCents))}
              </Text>
              <Text variant="bodyMedium" style={after < 0 ? styles.negative : styles.credit}>
                {t("pay.afterwards")}: {formatMoney(fromCents(after))}
              </Text>
            </View>

            <Button
              mode="contained"
              icon="check"
              disabled={cents <= 0}
              contentStyle={styles.tall}
              style={styles.save}
              onPress={save}
            >
              {t("pay.saveMovement")}
            </Button>
          </Card.Content>
        </Card>
      </ScrollView>

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
  dim: { opacity: 0.65 },
  credit: { color: "#3949ab", fontWeight: "600" },
  negative: { color: "#8a5a00", fontWeight: "600" },
  save: { borderRadius: 12 },
  tall: { height: 56 },
});
