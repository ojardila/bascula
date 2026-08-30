import { useCallback, useRef, useState } from "react";
import { View, ScrollView, StyleSheet, Share } from "react-native";
import {
  Text,
  Card,
  List,
  Divider,
  Button,
  Snackbar,
  Portal,
  Dialog,
} from "react-native-paper";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList } from "../types";
import {
  People as PeopleDb,
  Payments,
  Config,
  today,
  fromCents,
  type Balance,
  type FullBalance,
  type LedgerEntry,
  type Person,
} from "../db";
import { useT, formatDay } from "../i18n";
import { useSync } from "../sync/SyncProvider";
import * as Print from "expo-print";
import { buildReceipt } from "../receipt";
import { receiptHtml } from "../receiptHtml";

const ICON: Record<string, string> = {
  devengo: "scale-balance",
  pago: "cash",
  anticipo: "cash-fast",
  deduccion: "cart-minus",
  ajuste: "tune",
  reverso: "undo-variant",
};

export default function Account() {
  const { t, lang, money, num } = useT();
  // Only to say HOW MANY things are unsent, which is what §7.4's sentence
  // needs. Nothing on this screen changes behaviour because of it.
  const { status } = useSync();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { personId } = useRoute<RouteProp<RootStackParamList, "Account">>().params;
  const [person, setPerson] = useState<Person | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  // Decision 7 and §2.2. The figure to SHOW, which on a phone that has heard
  // from the server includes the jornales and contracts this app has no screen
  // for. `balance` above stays the figure that decides what is handed over.
  const [full, setFull] = useState<FullBalance | null>(null);
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [hasSettlement, setHasSettlement] = useState(false);
  // A settlement the user is considering voiding. The app tells people to void
  // one before correcting a settled pickup, so there has to be a way to do it.
  const [voiding, setVoiding] = useState<LedgerEntry | null>(null);
  const [snack, setSnack] = useState("");

  const load = useCallback(() => {
    setPerson(PeopleDb.byId(personId) ?? null);
    setBalance(Payments.balance(personId));
    setFull(Payments.fullBalance(personId));
    setRows(Payments.history(personId));
    setHasSettlement(Payments.settlements(personId).some((x) => x.status === "open"));
  }, [personId]);
  useFocusEffect(load);

  // A voided settlement keeps its earning in the history next to its reversal,
  // so without this the same one could be "voided" over and over, each time
  // reporting success.
  const voided = new Set(
    rows.filter((r) => r.reversesId != null).map((r) => r.reversesId as number),
  );
  // What this phone can hand over, and what it is allowed to pay out. Derived
  // from the ledger, movement by movement, exactly as before.
  const credit = balance?.balanceCents ?? 0;
  // What the worker is actually owed, which is not the same thing the moment
  // the farm books a jornal on the web (§2.2). On a phone that has never
  // synced these two are identical and nothing on this screen changes.
  const shown = full?.balanceCents ?? credit;
  const notItemisable = full?.notItemisableCents ?? 0;
  const owes = shown < 0; // the worker took an advance that is not worked off yet
  const busy = useRef(false);

  function payOutCredit() {
    if (busy.current || credit <= 0) return;
    busy.current = true;
    try {
      // Deliberately unlinked, unlike the two settle-and-pay screens: this
      // hands over an accumulated balance that can span several settlements
      // and none in particular. Naming one of them would be a worse lie than
      // naming none.
      Payments.pay(personId, credit, { method: "efectivo", note: t("pay.deliverCredit") });
      load();
      setSnack(
        t("pay.success", { amount: money(fromCents(credit)), name: person?.name ?? "" }),
      );
      // Released after the render that clears the balance, not in this same
      // synchronous tick — resetting immediately would mean the guard could
      // never be observed as taken. This screen stays mounted after paying,
      // so it does have to be released eventually.
      setTimeout(() => {
        busy.current = false;
      }, 0);
    } catch {
      busy.current = false;
      setSnack(t("pay.error"));
    }
  }

  /** The same settlement, on paper: printable and with room for a signature. */
  async function printReceipt() {
    const cfg = Config.get();
    const settlement = Payments.settlements(personId).find((x) => x.status === "open");
    if (!settlement) return;
    const items = Payments.itemsOf(settlement.id);
    // Was `rows.filter(r => r.kind === 'pago' && r.date >= periodStart)`, which
    // counted payments made for settlements closed months earlier — see
    // `movil.md` §9.3 and `PAID_AGAINST_SQL`.
    const paidCents = Payments.paidAgainst(settlement.id);
    try {
      await Print.printAsync({
        html: receiptHtml(
          {
            workerName: person ? `${person.name} ${person.lastName}`.trim() : "",
            workerDoc: person?.docId,
            farmLabel: cfg?.label ?? "",
            unit: cfg?.unit ?? "",
            lines: items.map((i) => ({
              week: i.week,
              weight: i.weight,
              amountCents: i.amountCents,
            })),
            // The document's own figure, not the sum of the lines above it.
            // A settlement that came down the feed for a week the worker also
            // spent on a jornal holds more than this phone can itemise, and
            // the receipt used to declare only the part it could print.
            grossCents: settlement.grossCents,
            balanceCents: credit,
            paidCents,
            date: today(),
          },
          lang,
        ),
      });
    } catch {
      /* the user dismissed the print dialog */
    }
  }

  // Plain text so it lands readable in the chat itself; the per-week breakdown
  // is the point, because the worker cannot verify a weight after the fact.
  async function share() {
    const cfg = Config.get();
    // The most recent settlement that is still valid: a receipt must not
    // document work that was annulled.
    const settlement = Payments.settlements(personId).find((x) => x.status === "open");
    const items = settlement ? Payments.itemsOf(settlement.id) : [];
    // Every payment made against THIS document, not just the last one: a week
    // paid in two instalments would otherwise report only the second. Against
    // this document and no other — see `movil.md` §9.3.
    const paidCents = settlement ? Payments.paidAgainst(settlement.id) : 0;
    const text = buildReceipt(
      {
        workerName: person ? `${person.name} ${person.lastName}`.trim() : "",
        farmLabel: cfg?.label ?? "",
        unit: cfg?.unit ?? "",
        monday: settlement?.periodStart ?? "",
        items,
        grossCents: settlement?.grossCents,
        paidCents,
        balance: balance ?? {
          personId, earnedCents: 0, paidCents: 0, deductedCents: 0,
          balanceCents: 0, lastMovementAt: null,
        },
        date: today(),
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
              style={shown > 0 ? styles.creditText : owes ? styles.owesText : styles.dim}
            >
              {shown > 0 ? t("pay.balanceTitle") : owes ? t("pay.owesUs") : t("pay.balanceTitle")}
            </Text>
            <Text
              variant="displaySmall"
              style={shown > 0 ? styles.creditBig : owes ? styles.owesBig : styles.zeroBig}
            >
              {money(fromCents(Math.abs(shown)))}
            </Text>

            {/*
              §2.2 and decision 7. The phone shows the whole balance and then
              says which part of it it cannot break down — «un saldo que cuenta
              la mitad del trabajo es un saldo que miente». Without the second
              line the first one would be a number the history underneath does
              not add up to, which is its own kind of lie.
            */}
            {notItemisable !== 0 && (
              <>
                <Text style={styles.dim}>
                  {t("pay.notItemisable", { amount: money(fromCents(Math.abs(notItemisable))) })}
                </Text>
                {credit > 0 && (
                  <Text style={styles.dim}>
                    {t("pay.canDeliverHere", { amount: money(fromCents(credit)) })}
                  </Text>
                )}
              </>
            )}
            {/* §7.4: while anything is unsent the figure is this phone's own,
                and it says so rather than passing for the farm's. */}
            {full?.provisional && full.serverCents !== null && (
              <Text style={styles.dim}>{t("pay.provisional", { n: num(status.pending) })}</Text>
            )}
            {!full?.provisional && full?.serverAt && (
              <Text style={styles.dim}>
                {t("pay.fromServer", { when: formatDay(full.serverAt.slice(0, 10), lang) })}
              </Text>
            )}
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
            disabled={!hasSettlement}
            onPress={share}
          >
            {t("pay.share")}
          </Button>
        </View>

        <Button
          mode="contained-tonal"
          icon="printer"
          style={styles.action}
          contentStyle={styles.tall}
          disabled={!hasSettlement}
          onPress={printReceipt}
        >
          {t("pay.print")}
        </Button>

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
                    onPress={
                      e.kind === "devengo" && e.settlementId && !voided.has(e.id)
                        ? () => setVoiding(e)
                        : undefined
                    }
                    titleStyle={voided.has(e.id) ? styles.voidedRow : undefined}
                    title={t(`pay.kind.${e.kind}`)}
                    description={`${formatDay(e.date, lang)}${e.note ? ` · ${e.note}` : ""}`}
                    left={(p) => <List.Icon {...p} icon={ICON[e.kind] ?? "circle-small"} />}
                    right={() => (
                      <Text
                        variant="titleSmall"
                        style={e.amountCents > 0 ? styles.plus : styles.minus}
                      >
                        {e.amountCents > 0 ? "+" : "−"}
                        {money(fromCents(Math.abs(e.amountCents)))}
                      </Text>
                    )}
                  />
                </View>
              ))
            )}
          </Card.Content>
        </Card>
      </ScrollView>

      <Portal>
        <Dialog visible={!!voiding} onDismiss={() => setVoiding(null)}>
          <Dialog.Icon icon="file-remove-outline" />
          <Dialog.Title style={styles.dialogTitle}>{t("pay.voidTitle")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium" style={{ textAlign: "center" }}>
              {voiding ? money(fromCents(voiding.amountCents)) : ""}
            </Text>
            <Text variant="bodySmall" style={styles.dialogBody}>
              {t("pay.voidBody")}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setVoiding(null)}>{t("confirm.cancel")}</Button>
            <Button
              textColor="#b3261e"
              onPress={() => {
                if (!voiding?.settlementId) return;
                try {
                  Payments.voidSettlement(voiding.settlementId, t("pay.voidNote"));
                  setVoiding(null);
                  load();
                  setSnack(t("pay.voided"));
                } catch {
                  setVoiding(null);
                  setSnack(t("pay.error"));
                }
              }}
            >
              {t("pay.void")}
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
  voidedRow: { textDecorationLine: "line-through", opacity: 0.6 },
  dialogTitle: { textAlign: "center" },
  dialogBody: { textAlign: "center", opacity: 0.7, marginTop: 8 },
  plus: { color: "#1b5e20", alignSelf: "center", fontWeight: "700" },
  minus: { opacity: 0.75, alignSelf: "center", fontWeight: "700" },
});
