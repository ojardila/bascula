/**
 * §7: what the pesador sees.
 *
 * The whole screen answers one question — *is my work safe?* — and it answers
 * it with numbers, not with a spinner. How many things are not sent, since
 * when, what is waiting for a decision, and a button that tries again.
 *
 * The conflict cards below obey §7.3 and the rules are not negotiable:
 *   - at most two buttons, because a third means one of them is the owner's
 *     decision and belongs on a screen that shows what it costs;
 *   - never a diff, never "local version / remote version". The farm does not
 *     think in versions, it thinks in Ana and in Tuesday;
 *   - nothing auto-resolves and nothing disappears on its own. A card closes
 *     because somebody pressed something, and what they pressed is recorded.
 */

import { useCallback, useState } from "react";
import { ScrollView, View, StyleSheet } from "react-native";
import { Text, Card, Button, Divider, Chip, ActivityIndicator, Snackbar } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../types";
import { repository, fromCents } from "../db";
import type { Conflict } from "../data/repository.ts";
import { useT, formatDay } from "../i18n";
import { useSync } from "../sync/SyncProvider";

export default function SyncStatus() {
  const { t, lang, money, num } = useT();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { status, syncNow, refresh } = useSync();
  const [cards, setCards] = useState<Conflict[]>([]);
  const [snack, setSnack] = useState("");

  const load = useCallback(() => {
    setCards(repository.sync.conflicts());
  }, []);
  useFocusEffect(load);

  const resolve = (c: Conflict, resolution: string, message: string) => {
    repository.sync.resolveConflict(c.id, resolution);
    load();
    refresh();
    setSnack(message);
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* The headline. One number, big, because it is the one a dueño checks
            before walking away from the lote. */}
        <Card mode="elevated" style={styles.card}>
          <Card.Content style={styles.hero}>
            <MaterialCommunityIcons
              name={heroIcon(status.tone)}
              size={40}
              color={heroColour(status.tone)}
            />
            <Text variant="headlineMedium" style={styles.heroNumber}>
              {status.pending === 0 ? t("sync.allSent") : num(status.pending)}
            </Text>
            {status.pending > 0 && (
              <Text style={styles.dim}>{t("sync.notSentYet", { n: status.pending })}</Text>
            )}
            <Text style={styles.dim}>
              {status.lastPullAt
                ? t("sync.lastSync", { when: formatDay(status.lastPullAt.slice(0, 10), lang) })
                : t("sync.neverSynced")}
            </Text>
            {!!status.farmName && (
              <Chip icon="barn" compact style={styles.farmChip}>
                {status.farmName}
              </Chip>
            )}
          </Card.Content>
          <Card.Actions>
            <Button
              mode="contained"
              icon={status.busy ? undefined : "sync"}
              disabled={status.busy || !status.registered}
              onPress={() => void syncNow().then(load)}
            >
              {status.busy ? <ActivityIndicator color="#fff" size={18} /> : t("sync.syncNow")}
            </Button>
            {!status.registered && (
              <Button icon="link-variant" onPress={() => navigation.navigate("SyncSetup")}>
                {t("sync.connect")}
              </Button>
            )}
          </Card.Actions>
        </Card>

        {/* Why it is not sent, when there is a reason worth naming. "Sin
            señal" is a different thing from "algo salió mal", and the person
            reading this can act on the first and not on the second. */}
        {!!status.lastError && status.pending > 0 && (
          <Card mode="outlined" style={styles.card}>
            <Card.Content>
              <Text style={styles.warn}>{explain(status.lastError, t)}</Text>
              <Text style={styles.dim}>{t("sync.willRetry")}</Text>
            </Card.Content>
          </Card>
        )}

        {/* What this token was not allowed to read. A weigher's pull comes
            back without the money, correctly — and the screen has to say so
            rather than let them believe the phone is up to date. */}
        {status.skipped.length > 0 && (
          <Card mode="outlined" style={styles.card}>
            <Card.Title title={t("sync.notRead")} />
            <Card.Content>
              {status.skipped.map((s) => (
                <Text key={s.what} style={styles.dim}>
                  · {s.what} — {s.reason}
                </Text>
              ))}
            </Card.Content>
          </Card>
        )}

        {cards.length > 0 && (
          <Text variant="titleMedium" style={styles.section}>
            {t("sync.needsYou", { n: cards.length })}
          </Text>
        )}

        {cards.map((c) => (
          <ConflictCard
            key={c.id}
            conflict={c}
            t={t}
            money={money}
            num={num}
            lang={lang}
            onResolve={resolve}
            onOpenWorker={(personId) => navigation.navigate("Account", { personId })}
          />
        ))}

        {cards.length === 0 && status.registered && (
          <Text style={[styles.dim, styles.section]}>{t("sync.noConflicts")}</Text>
        )}
      </ScrollView>

      <Snackbar visible={!!snack} onDismiss={() => setSnack("")} duration={2500}>
        {snack}
      </Snackbar>
    </View>
  );
}

/**
 * One card per problem. A person, a date, and an amount or a quantity — §7.3
 * says a card without those three is not a card, it is noise, and it is taken
 * out of the design.
 */
function ConflictCard({
  conflict,
  t,
  money,
  num,
  lang,
  onResolve,
  onOpenWorker,
}: {
  conflict: Conflict;
  t: (k: string, v?: Record<string, string | number>) => string;
  money: (n: number) => string;
  num: (n: number) => string;
  lang: string;
  onResolve: (c: Conflict, resolution: string, message: string) => void;
  onOpenWorker: (personId: number) => void;
}) {
  const p = conflict.payload;
  const person = (p.person as string) ?? t("sync.someone");

  switch (conflict.kind) {
    case "pickup-already-settled":
      return (
        <Card mode="elevated" style={styles.card}>
          <Card.Content>
            <Text variant="titleSmall">
              {person}
              {p.date ? ` · ${formatDay(String(p.date).slice(0, 10), lang as never)}` : ""}
            </Text>
            <Text style={styles.body}>
              {t("conflict.alreadySettled", { qty: num(Number(p.quantity ?? 0)) })}
            </Text>
          </Card.Content>
          <Card.Actions>
            {conflict.personId !== null && (
              <Button onPress={() => onOpenWorker(conflict.personId!)}>
                {t("conflict.seeHistory")}
              </Button>
            )}
            {/* The change stays on the phone either way. This button records
                that a person looked at it and decided to leave the settlement
                alone; voiding it is the owner's decision, elsewhere. */}
            <Button
              mode="contained-tonal"
              onPress={() =>
                onResolve(conflict, "kept-settlement", t("conflict.closed"))
              }
            >
              {t("conflict.understood")}
            </Button>
          </Card.Actions>
        </Card>
      );

    case "read-only-on-phone":
      return (
        <Card mode="elevated" style={styles.card}>
          <Card.Content>
            <Text variant="titleSmall">{t("conflict.readOnlyTitle")}</Text>
            <Text style={styles.body}>{t("conflict.readOnlyBody")}</Text>
          </Card.Content>
          <Card.Actions>
            <Button
              mode="contained-tonal"
              onPress={() => onResolve(conflict, "acknowledged", t("conflict.closed"))}
            >
              {t("conflict.understood")}
            </Button>
          </Card.Actions>
        </Card>
      );

    case "balance-mismatch":
      return (
        <Card mode="elevated" style={[styles.card, styles.red]}>
          <Card.Content>
            <Text variant="titleSmall">{person}</Text>
            <Text style={styles.body}>
              {t("conflict.balanceMismatch", {
                local: money(fromCents(Number(p.localCents ?? 0))),
                server: money(fromCents(Number(p.serverCents ?? 0))),
              })}
            </Text>
          </Card.Content>
          <Card.Actions>
            {conflict.personId !== null && (
              <Button onPress={() => onOpenWorker(conflict.personId!)}>
                {t("conflict.seeHistory")}
              </Button>
            )}
            {/* Deliberately NOT "use the server's figure". §7.4: a total that
                comes down the wire and gets stored is the materialised balance
                this design has refused three times, and copying it hides the
                bug instead of reporting it. */}
            <Button
              mode="contained-tonal"
              onPress={() => onResolve(conflict, "reported", t("conflict.reported"))}
            >
              {t("conflict.report")}
            </Button>
          </Card.Actions>
        </Card>
      );

    case "balance-not-itemisable":
      return (
        <Card mode="elevated" style={styles.card}>
          <Card.Content>
            <Text variant="titleSmall">{person}</Text>
            {/* Decision 7: the phone shows the FULL balance even when it can
                only break down the weighings. A balance that counts half the
                work is a balance that lies, and whoever reads it has no way
                of knowing. */}
            <Text style={styles.body}>
              {t("conflict.notItemisable", {
                server: money(fromCents(Number(p.serverCents ?? 0))),
              })}
            </Text>
          </Card.Content>
          <Card.Actions>
            {conflict.personId !== null && (
              <Button onPress={() => onOpenWorker(conflict.personId!)}>
                {t("conflict.seeHistory")}
              </Button>
            )}
            <Button
              mode="contained-tonal"
              onPress={() => onResolve(conflict, "acknowledged", t("conflict.closed"))}
            >
              {t("conflict.understood")}
            </Button>
          </Card.Actions>
        </Card>
      );

    default:
      return (
        <Card mode="elevated" style={styles.card}>
          <Card.Content>
            <Text variant="titleSmall">{person}</Text>
            <Text style={styles.body}>
              {String(p.message ?? p.code ?? conflict.kind)}
            </Text>
            <Text style={styles.dim}>{conflict.entity}</Text>
          </Card.Content>
          <Card.Actions>
            <Button
              mode="contained-tonal"
              onPress={() => onResolve(conflict, "acknowledged", t("conflict.closed"))}
            >
              {t("conflict.understood")}
            </Button>
          </Card.Actions>
        </Card>
      );
  }
}

const heroIcon = (tone: string) =>
  tone === "conflict"
    ? "alert-circle"
    : tone === "offline"
      ? "cloud-off-outline"
      : tone === "pending"
        ? "cloud-upload-outline"
        : "cloud-check-outline";

const heroColour = (tone: string) =>
  tone === "conflict" ? "#b3261e" : tone === "offline" ? "#b26a00" : "#2e7d32";

function explain(lastError: string, t: (k: string) => string): string {
  if (/NETWORK|TIMEOUT/.test(lastError)) return t("sync.errNoSignal");
  if (/PARTIAL/.test(lastError)) return t("sync.errPartial");
  if (/UNAUTHORIZED|FORBIDDEN|TOKEN/.test(lastError)) return t("sync.errAuth");
  return lastError;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 12, paddingBottom: 32 },
  card: { marginTop: 12 },
  hero: { alignItems: "center", gap: 4, paddingVertical: 8 },
  heroNumber: { fontWeight: "800" },
  farmChip: { marginTop: 8 },
  dim: { opacity: 0.65 },
  warn: { color: "#8a5a00", fontWeight: "600" },
  body: { marginTop: 6, lineHeight: 20 },
  section: { marginTop: 20, fontWeight: "700" },
  red: { borderLeftWidth: 4, borderLeftColor: "#b3261e" },
  divider: { marginVertical: 8 },
});

export { Divider };
