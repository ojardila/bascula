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
import { explainSyncError } from "../sync/explain.ts";

export default function SyncStatus() {
  const { t, lang, money, num } = useT();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { status, syncNow, refresh } = useSync();
  const [cards, setCards] = useState<Conflict[]>([]);
  const [snack, setSnack] = useState("");
  /**
   * Whether §8's mudanza already happened, from the record rather than from a
   * flag somebody could forget to clear. `already-imported` counts: the farm's
   * season IS on the server, and the only honest thing to do with a second
   * offer to upload it is to stop offering.
   */
  const [seasonUploaded, setSeasonUploaded] = useState(false);

  const explained = explainSyncError(status.lastError ?? "");

  const load = useCallback(() => {
    setCards(repository.sync.conflicts());
    setSeasonUploaded(
      repository.sync
        .importRuns(50)
        .some((r) => r.status === "imported" || r.status === "already-imported"),
    );
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

        {/*
          §8 fase 3 and 4. Only for a token that may move money, and only
          until the farm's season is up there: once it is, this is a button
          that can do nothing but tell somebody so, and a button like that on
          the money screen of a farm mid-harvest is an invitation.
        */}
        {status.registered &&
          (status.role === "owner" || status.role === "admin") &&
          !seasonUploaded && (
            <Card mode="outlined" style={styles.card}>
              <Card.Title
                title={t("import.openTitle")}
                left={(p) => (
                  <MaterialCommunityIcons
                    {...p}
                    name="database-arrow-up"
                    size={24}
                    color="#2e7d32"
                  />
                )}
              />
              <Card.Content>
                <Text style={styles.dim}>{t("import.openBody")}</Text>
              </Card.Content>
              <Card.Actions>
                <Button
                  mode="contained-tonal"
                  icon="cloud-upload"
                  onPress={() => navigation.navigate("SeasonImport")}
                >
                  {t("import.open")}
                </Button>
              </Card.Actions>
            </Card>
          )}

        {/*
          What went wrong, whenever something did.

          This used to be gated on `status.pending > 0`, which hid the one
          case that matters most: a phone with an empty outbox whose token was
          revoked, or whose farm was suspended, or whose build the server will
          no longer talk to. It has nothing to send, so it showed a green
          "Todo enviado" and a date — while receiving nothing at all, for days.
          An empty outbox is not the same thing as being up to date.

          The wording comes from `explain.ts`, which is tested against the
          protocol's own list of codes, so a state this screen cannot name
          fails a test instead of reaching a lote as a raw string.
        */}
        {!!status.lastError && (
          <Card mode="outlined" style={[styles.card, !explained.retryable && styles.red]}>
            <Card.Content>
              <Text style={styles.warn}>{t(explained.key)}</Text>
              <Text style={styles.dim}>
                {explained.retryable ? t("sync.willRetry") : t("sync.wontRetry")}
              </Text>
              {/* The code, because somebody is going to have to read it out
                  over the phone to whoever can fix it. */}
              {!explained.retryable && (
                <Text style={styles.dim}>{t("sync.errCode", { code: explained.code })}</Text>
              )}
            </Card.Content>
          </Card>
        )}

        {/*
          §6.1 and §3.1. The pull stopped with the server still holding
          changes — a phone that has been out of signal for a fortnight drains
          what it can and comes back for the rest. Nothing is lost and the
          cursor did move, but the phone is NOT level, the settle button is
          off, and the screen has to say which of those two things is true
          rather than showing a date and letting somebody assume.
        */}
        {status.stillBehind && (
          <Card mode="outlined" style={styles.card}>
            <Card.Title title={t("sync.behindTitle")} />
            <Card.Content>
              <Text style={styles.body}>{t("sync.behindBody")}</Text>
              {status.behind > 0 && (
                <Text style={styles.dim}>
                  {t("sync.behindCount", { n: num(status.behind) })}
                </Text>
              )}
            </Card.Content>
          </Card>
        )}

        {/*
          §3.4. The phone's cursor was older than the feed still retains — 180
          days — so the transport re-read the farm from the beginning on its
          own. Nothing was lost and nobody is being asked to decide anything;
          the card exists because the alternative is silence, and the next
          handshake will report this phone as tens of thousands of changes
          behind. A counter that appears to have gone backwards, with no
          sentence beside it, is how a pesador concludes the phone lost the
          season.
        */}
        {status.bootstrapped && (
          <Card mode="outlined" style={styles.card}>
            <Card.Title title={t("sync.bootstrapTitle")} />
            <Card.Content>
              <Text style={styles.body}>{t("sync.bootstrapBody")}</Text>
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

    // §5.6. The document this phone typed already belongs to somebody the farm
    // took off the payroll. Two buttons at most, and neither of them merges
    // anybody: the card exists so a person who knows both names can decide.
    case "worker-exists-deleted":
      return (
        <Card mode="elevated" style={styles.card}>
          <Card.Content>
            <Text variant="titleSmall">{person}</Text>
            <Text style={styles.body}>
              {t("conflict.workerExistsDeleted", {
                name: String(p.serverName ?? t("sync.someone")),
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

    // §5.5. The gross moved between the preview and the write, and the server
    // wrote nothing. Whether the difference has an explanation is the server's
    // own `payableIdsProvided`, and the card says which of the two it is
    // rather than blaming a reprice for a late weighing.
    case "gross-changed":
      return (
        <Card mode="elevated" style={[styles.card, styles.red]}>
          <Card.Content>
            <Text variant="titleSmall">{person}</Text>
            <Text style={styles.body}>
              {t("conflict.grossChanged", {
                expected: money(fromCents(Number(p.expectedCents ?? 0))),
                actual: money(fromCents(Number(p.actualCents ?? 0))),
              })}
            </Text>
            <Text style={styles.dim}>
              {p.explained
                ? t("conflict.grossChangedWhy", {
                    added: Number(p.addedCount ?? 0),
                    removed: Number(p.removedCount ?? 0),
                  })
                : t("conflict.grossChangedUnknown")}
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

    // §4.3: the same id already carries different data on the server, so
    // somebody edited a row the server had already accepted under that id.
    // The engine raises this and the screen used to have no case for it — the
    // card printed the literal word "diverged" and nothing else, which is a
    // card without a sentence on it and therefore, by §7.3, not a card.
    case "diverged":
      return (
        <Card mode="elevated" style={styles.card}>
          <Card.Content>
            <Text variant="titleSmall">{person}</Text>
            <Text variant="labelLarge" style={styles.dim}>
              {t("conflict.divergedTitle")}
            </Text>
            <Text style={styles.body}>{t("conflict.diverged")}</Text>
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
            {/* A heading, so the card is not a bare server message. The code
                stays underneath: an error this table has not met is worse to
                look at than a sentence and better than a phone deciding on
                its own what to do about somebody's pay. */}
            <Text variant="labelLarge" style={styles.dim}>
              {t("conflict.rejectedTitle")}
            </Text>
            <Text style={styles.body}>
              {String(p.message ?? p.code ?? conflict.kind)}
            </Text>
            <Text style={styles.dim}>
              {conflict.entity}
              {p.code ? ` · ${String(p.code)}` : ""}
            </Text>
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
