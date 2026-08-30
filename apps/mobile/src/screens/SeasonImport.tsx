/**
 * The screen that moves a farm's season to the server. §8 fase 3 and 4.
 *
 * Whoever presses this is moving the nómina of their finca. That is not a
 * settings toggle, and the screen is built around three sentences the person
 * has to be able to say back before anything happens:
 *
 *  1. **What is about to go up.** How many people, how many weighings, how
 *     many kilos, and how much money. §8 fase 4 says this happens with
 *     somebody present; the numbers are what that somebody is present FOR, and
 *     they are on the screen before the button, not after it.
 *  2. **What happened, with the balance check in front.** The whole design of
 *     the import is that the server derives every worker's balance and refuses
 *     the lot if one centavo disagrees. That result is the headline of the
 *     "after" state, not a detail underneath the counts.
 *  3. **That a failure cost nothing.** If it did not go up, the screen says
 *     "no se subió nada" and "tu teléfono sigue exactamente igual" — in those
 *     words, because that is the property §8's whole plan rests on and the
 *     person staring at a red card has no other way to know it.
 *
 * There is no progress bar without a number on it. A spinner during a
 * fifteen-minute upload over a farm's uplink tells a person nothing except
 * that the app has not crashed yet.
 */

import { useCallback, useEffect, useState } from "react";
import { ScrollView, View, StyleSheet } from "react-native";
import {
  Text,
  Card,
  Button,
  Chip,
  Divider,
  Dialog,
  Portal,
  ActivityIndicator,
} from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";

import { fromCents } from "../db";
import { useT, formatDay } from "../i18n";
import { useSync } from "../sync/SyncProvider";
import { SeasonExportError, type SeasonExport } from "../sync/seasonExport.ts";
import {
  seasonWasImported,
  SEASON_IMPORT_TIMEOUT_MS,
  type BalanceMismatch,
  type SeasonImportOutcome,
  type SeasonImportProgress,
} from "../sync/seasonImport.ts";

export default function SeasonImport() {
  const { t, lang, money, num } = useT();
  const { status, seasonImporter } = useSync();

  const [preview, setPreview] = useState<SeasonExport | null>(null);
  const [previewError, setPreviewError] = useState<string[] | null>(null);
  const [progress, setProgress] = useState<SeasonImportProgress | null>(null);
  const [outcome, setOutcome] = useState<SeasonImportOutcome | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Rebuilt every time the screen is opened, because it is a read and because
  // the farm has been weighing since the last time somebody looked.
  const load = useCallback(() => {
    if (!seasonImporter) return;
    try {
      setPreview(seasonImporter.preview());
      setPreviewError(null);
    } catch (e) {
      setPreview(null);
      setPreviewError(
        e instanceof SeasonExportError ? e.problems : [String((e as Error)?.message ?? e)],
      );
    }
  }, [seasonImporter]);
  useFocusEffect(load);

  const upload = async () => {
    if (!seasonImporter) return;
    setConfirming(false);
    setOutcome(null);
    setProgress({ phase: "building", rows: 0, bytes: 0, since: Date.now() });
    try {
      const result = await seasonImporter.run({ onProgress: setProgress });
      setOutcome(result);
    } finally {
      setProgress(null);
      load();
    }
  };

  // §2 and the roles: a pesador's token cannot read money, so it cannot move a
  // nómina. Said on the screen rather than discovered by a 403 halfway up.
  //
  // OWNER ONLY, and admin is not a near miss — it is the mismatch this comment
  // was written to prevent, pointing the wrong way. The server's permission
  // table has `ActionImportSeason: {Roles: owners}` and `owners` is
  // `[]domain.Role{domain.RoleOwner}`, so an admin who got this far uploaded
  // the whole season and read a 403 at the end of it. On a Tuesday morning,
  // with somebody standing there, having spent the climb. The mudanza happens
  // once; the person who can do it should be the only one offered it.
  //
  // The comment was right and `import.noMoney` was wrong: it read «solo el
  // dueño o un administrador», in all three languages, on the one card an
  // administrator is the likeliest person to be reading — because they are the
  // one this gate just stopped. It told them they could do the thing the
  // button beside it had disabled. The sentence now names the same single role
  // the permission table does, and says who to go and ask.
  const mayImport = status.role === "owner";

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Card mode="elevated" style={styles.card}>
          <Card.Content style={styles.hero}>
            <MaterialCommunityIcons name="database-arrow-up" size={40} color="#2e7d32" />
            <Text variant="titleLarge" style={styles.heroTitle}>
              {t("import.title")}
            </Text>
            <Text style={styles.centered}>{t("import.intro")}</Text>
            <Text style={[styles.centered, styles.safe]}>{t("import.safety")}</Text>
            {!!status.farmName && (
              <Chip icon="barn" compact style={styles.farmChip}>
                {status.farmName}
              </Chip>
            )}
          </Card.Content>
        </Card>

        {!status.registered && (
          <Card mode="outlined" style={styles.card}>
            <Card.Content>
              <Text style={styles.warn}>{t("import.notRegistered")}</Text>
            </Card.Content>
          </Card>
        )}

        {status.registered && !mayImport && (
          <Card mode="outlined" style={styles.card}>
            <Card.Content>
              <Text style={styles.warn}>{t("import.noMoney")}</Text>
            </Card.Content>
          </Card>
        )}

        {/* The season this phone cannot re-enter, counted. Before the button. */}
        {preview && (
          <Card mode="elevated" style={styles.card}>
            <Card.Title title={t("import.whatGoes")} />
            <Card.Content>
              {/* The whole thing in one sentence, before the grid.
                  A grid of eight figures is a report; what somebody deciding
                  whether to press this needs first is the size of the thing in
                  the four words he would use himself — how many of his people,
                  how many pesadas, how many weeks, and how much money. The
                  grid stays underneath for whoever wants to check it, but it
                  is no longer the first thing to parse. */}
              <Text variant="titleMedium" style={styles.headline}>
                {t("import.headline", {
                  workers: num(preview.totals.workers),
                  pickups: num(preview.totals.workRecords),
                  weeks: num(preview.reconciliation.weeks.length),
                  money: money(fromCents(preview.totals.balanceCents)),
                })}
              </Text>
              {preview.totals.firstDay && preview.totals.lastDay && (
                <Text style={styles.dim}>
                  {t("import.range", {
                    from: formatDay(preview.totals.firstDay, lang),
                    to: formatDay(preview.totals.lastDay, lang),
                  })}
                </Text>
              )}
              <View style={styles.grid}>
                <Figure label={t("import.workers")} value={num(preview.totals.workers)} />
                {/* The season's length in the unit a farm is paid in. It costs
                    nothing: `reconciliation.weeks` is already derived for the
                    check the server runs, and «22 semanas» is the figure a
                    person uses to recognise their own season. */}
                <Figure
                  label={t("import.weeks")}
                  value={num(preview.reconciliation.weeks.length)}
                />
                <Figure label={t("import.plots")} value={num(preview.totals.plots)} />
                <Figure
                  label={t("import.pickups")}
                  value={num(preview.totals.workRecords)}
                  note={t("import.kg", { kg: num(preview.totals.kg) })}
                />
                <Figure
                  label={t("import.settlements")}
                  value={num(preview.totals.settlements)}
                  note={t("import.lines", { n: num(preview.totals.settlementItems) })}
                />
                <Figure label={t("import.ledger")} value={num(preview.totals.ledgerEntries)} />
                <Figure label={t("import.weekPrices")} value={num(preview.totals.weekPrices)} />
              </View>

              <Divider style={styles.divider} />

              {/* The money, on its own, because it is the reason this is not
                  an export button in a settings screen. */}
              <Text variant="labelLarge" style={styles.dim}>
                {t("import.money")}
              </Text>
              <Row label={t("import.earned")} value={money(fromCents(preview.totals.earnedCents))} />
              <Row label={t("import.paid")} value={money(fromCents(preview.totals.paidCents))} />
              <Row
                label={t("import.balance")}
                value={money(fromCents(preview.totals.balanceCents))}
                strong
              />
              <Text style={[styles.dim, styles.footnote]}>
                {t("import.balanceNote", { n: num(preview.reconciliation.balances.length) })}
              </Text>
            </Card.Content>
            <Card.Actions>
              <Button
                mode="contained"
                icon="cloud-upload"
                disabled={!mayImport || !!progress || seasonImporter?.busy}
                onPress={() => setConfirming(true)}
              >
                {t("import.upload")}
              </Button>
            </Card.Actions>
          </Card>
        )}

        {/* A season that cannot even be read out. §1.3's `missing = 0` and the
            orphan check: both are fase 1 exit criteria somebody skipped, and
            both have to be fixed before anything is moved. */}
        {previewError && (
          <Card mode="outlined" style={[styles.card, styles.red]}>
            <Card.Title title={t("import.cannotBuild")} />
            <Card.Content>
              {previewError.map((p, i) => (
                <Text key={i} style={styles.body}>
                  · {p}
                </Text>
              ))}
            </Card.Content>
          </Card>
        )}

        {progress && <Progress progress={progress} t={t} num={num} />}

        {outcome && <Outcome outcome={outcome} t={t} money={money} num={num} onRetry={upload} />}
      </ScrollView>

      <Portal>
        <Dialog visible={confirming} onDismiss={() => setConfirming(false)}>
          <Dialog.Title>{t("import.confirmTitle")}</Dialog.Title>
          <Dialog.Content>
            <Text style={styles.body}>
              {t("import.confirmBody", {
                n: num(preview?.totals.workRecords ?? 0),
                m: num(preview?.totals.ledgerEntries ?? 0),
              })}
            </Text>
            {/* The money, in the dialog. `usability.md` protects the crew
                payroll screen as the model for a confirmation — "a confirmation
                that lists every person by name" — because it makes the person
                confirm the thing itself and not a row count. Twenty-four names
                do not fit here, but the figure they add up to does, and it is
                what makes this a decision rather than an OK. */}
            <Text style={[styles.body, styles.strong]}>
              {t("import.confirmMoney", {
                money: money(fromCents(preview?.totals.balanceCents ?? 0)),
              })}
            </Text>
            <Text style={[styles.body, styles.safe]}>{t("import.safety")}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirming(false)}>{t("import.cancel")}</Button>
            <Button mode="contained" onPress={() => void upload()}>
              {t("import.confirm")}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

/**
 * Where it is, in rows, megabytes and seconds — never in a spinner alone.
 *
 * `POST /v1/import/season` is one request carrying the whole season, so there
 * is no batch counter and no percentage: `fetch` does not report how much of a
 * body has left the phone, and a bar that guessed would be lying about the one
 * number the person is watching. What CAN be said honestly is said:
 *
 *  - which step it is on, and how many rows and megabytes are in flight —
 *    11,7 MB is the reason this takes what it takes, and a person who is told
 *    that stops wondering whether the app is stuck;
 *  - how long it has been going, ticking every second, which is the only
 *    evidence a viewer has that the process is alive at all;
 *  - how long it will wait before giving up, so the wait has an end somebody
 *    can plan around instead of an unbounded one;
 *  - and, in green and in the same words as everywhere else, that a failure
 *    here costs nothing. That sentence used to appear only before the button
 *    and after the answer. The minutes in between are exactly when somebody
 *    with a bad signal starts wondering whether they have broken the farm's
 *    payroll, and it is when they most need to be told they have not.
 */
function Progress({
  progress,
  t,
  num,
}: {
  progress: SeasonImportProgress;
  t: (k: string, v?: Record<string, string | number>) => string;
  num: (n: number) => string;
}) {
  // Anchored to the phase's own start (`since`), not to the tap: building and
  // checking a season of eighteen thousand weighings is itself tens of
  // seconds, and counting those against the request's deadline would be
  // measuring the wrong thing.
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - progress.since);
  useEffect(() => {
    setElapsedMs(Date.now() - progress.since);
    const timer = setInterval(() => setElapsedMs(Date.now() - progress.since), 1000);
    return () => clearInterval(timer);
  }, [progress.since, progress.phase]);

  const sending = progress.phase === "sending";
  return (
    <Card mode="elevated" style={styles.card}>
      <Card.Content style={styles.hero}>
        <ActivityIndicator />
        <Text variant="titleSmall" style={styles.centered}>
          {sending && progress.rows > 0
            ? t("import.phaseSending", { rows: num(progress.rows) })
            : t(`import.phase.${progress.phase}`)}
        </Text>

        {sending && progress.bytes > 0 && (
          <Text style={[styles.dim, styles.centered]}>
            {t("import.size", { mb: num(round1(progress.bytes / 1_000_000)) })}
          </Text>
        )}

        {/* The clock. Without it the only difference between "subiendo" and
            "colgado" is the person's patience. */}
        <Text style={[styles.centered, styles.strong]}>
          {t("import.elapsed", { clock: clockOf(elapsedMs) })}
        </Text>
        {sending && (
          <Text style={[styles.dim, styles.centered]}>
            {t("import.waitUntil", {
              min: num(Math.round(SEASON_IMPORT_TIMEOUT_MS / 60000)),
            })}
          </Text>
        )}

        <Text style={[styles.dim, styles.centered]}>{t("import.dontClose")}</Text>

        {/* What the silence at the end is.
            Measured, not guessed. Moving a real season — 18.000 pesadas,
            39.568 filas, 9,5 MB — against real Postgres over a link with no
            latency at all still took 77 s on a cold database and 16 s on a
            warm one (`sync/mudanza.e2e.ts`). None of that is the uplink: it is
            the server writing forty thousand rows in one transaction and
            deriving every worker's balance before it commits any of them. Over
            a farm's link the upload is the larger half and this tail is still
            minutes on top of it.
            `fetch` cannot tell the phone when the last byte left, so the
            screen cannot honestly switch to a «guardando» phase — but it can
            say that the long quiet part is expected, which is the difference
            between waiting and deciding the app has hung. */}
        {sending && (
          <Text style={[styles.dim, styles.centered]}>{t("import.tail")}</Text>
        )}
        {/* The property §8's whole plan rests on, said while the waiting is
            happening and not only before and after it. */}
        <Text style={[styles.centered, styles.safe]}>{t("import.safety")}</Text>
      </Card.Content>
    </Card>
  );
}

/** `m:ss`, because "134 segundos" is not a length anybody feels. */
function clockOf(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * What happened, with the balance check first.
 *
 * The failure branches all say the same two things in the same words: nothing
 * was uploaded, and the phone has not changed. They are separate branches only
 * because the REASON differs and a person deciding what to do next needs it —
 * a rejected import is somebody's arithmetic, a failed one is the network.
 */
function Outcome({
  outcome,
  t,
  money,
  num,
  onRetry,
}: {
  outcome: SeasonImportOutcome;
  t: (k: string, v?: Record<string, string | number>) => string;
  money: (n: number) => string;
  num: (n: number) => string;
  onRetry: () => void;
}) {
  if (seasonWasImported(outcome)) {
    const already = outcome.status === "already-imported";
    const checked = outcome.report?.balancesChecked ?? 0;
    return (
      <Card mode="elevated" style={[styles.card, styles.green]}>
        <Card.Content>
          <View style={styles.titleRow}>
            <MaterialCommunityIcons name="check-decagram" size={28} color="#2e7d32" />
            <Text variant="titleMedium" style={styles.grow}>
              {already ? t("import.alreadyTitle") : t("import.okTitle")}
            </Text>
          </View>

          {/* The verification, in first place. It is the reason this import is
              trustworthy at all, and it belongs above the counts. */}
          {!already && (
            <Text style={[styles.body, styles.strong]}>
              {t("import.okBalances", { n: num(checked) })}
            </Text>
          )}
          {already && <Text style={styles.body}>{t("import.alreadyBody")}</Text>}

          {outcome.report && (
            <Text style={styles.dim}>
              {t("import.okCounts", {
                workers: num(outcome.report.workers.written),
                records: num(outcome.report.workRecords.written),
                ledger: num(outcome.report.ledger.written),
              })}
            </Text>
          )}
          <Text style={styles.dim}>
            {t("import.duration", { s: num(Math.round(outcome.durationMs / 1000)) })}
          </Text>
        </Card.Content>
      </Card>
    );
  }

  const rejected = outcome.status === "rejected";
  const refused = outcome.status === "refused";
  const mismatches = outcome.mismatches;

  return (
    <Card mode="elevated" style={[styles.card, styles.red]}>
      <Card.Content>
        <View style={styles.titleRow}>
          <MaterialCommunityIcons name="alert-circle" size={28} color="#b3261e" />
          <Text variant="titleMedium" style={styles.grow}>
            {t("import.failTitle")}
          </Text>
        </View>

        {/* The sentence the whole plan rests on, in every failure branch. */}
        <Text style={[styles.body, styles.strong]}>{t("import.failSafe")}</Text>

        <Text style={styles.body}>
          {rejected
            ? t("import.rejectedBody")
            : refused
              ? t("import.refusedBody")
              : t("import.brokeBody", {
                  code: outcome.error?.code ?? "?",
                  rows: num(outcome.rows),
                })}
        </Text>

        {mismatches.length > 0 && (
          <>
            <Divider style={styles.divider} />
            <Text variant="labelLarge">{t("import.problems")}</Text>
            {mismatches.map((m: BalanceMismatch) => (
              <Text key={m.workerId} style={styles.body}>
                ·{" "}
                {t("import.mismatchRow", {
                  name: m.name ?? t("sync.someone"),
                  phone: money(fromCents(m.phoneCents)),
                  server: money(fromCents(m.serverCents)),
                })}
              </Text>
            ))}
          </>
        )}

        {outcome.problems.length > 0 && (
          <>
            <Divider style={styles.divider} />
            <Text variant="labelLarge">{t("import.problems")}</Text>
            {outcome.problems.slice(0, 10).map((p, i) => (
              <Text key={i} style={styles.body}>
                · {p}
              </Text>
            ))}
            {outcome.problems.length > 10 && (
              <Text style={styles.dim}>
                {t("import.andMore", { n: num(outcome.problems.length - 10) })}
              </Text>
            )}
          </>
        )}
      </Card.Content>
      <Card.Actions>
        {/* Only where trying again can work. A rejected import needs somebody
            to find out why the arithmetic differs first; a button that offers
            to repeat it would just produce the same refusal. */}
        {!rejected && (
          <Button mode="contained-tonal" icon="reload" onPress={onRetry}>
            {t("import.retry")}
          </Button>
        )}
      </Card.Actions>
    </Card>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View style={styles.figure}>
      <Text variant="headlineSmall" style={styles.strong}>
        {value}
      </Text>
      <Text style={styles.dim}>{label}</Text>
      {!!note && <Text style={styles.dim}>{note}</Text>}
    </View>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.grow, strong && styles.strong]}>{label}</Text>
      <Text style={strong && styles.strong}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 12, paddingBottom: 40 },
  card: { marginTop: 12 },
  hero: { alignItems: "center", gap: 8, paddingVertical: 8 },
  heroTitle: { fontWeight: "800", textAlign: "center" },
  centered: { textAlign: "center" },
  safe: { color: "#2e7d32", fontWeight: "600" },
  farmChip: { marginTop: 4 },
  headline: { fontWeight: "700", lineHeight: 24, marginBottom: 6 },
  grid: { flexDirection: "row", flexWrap: "wrap", marginTop: 8 },
  figure: { width: "33%", paddingVertical: 8 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 4 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1 },
  strong: { fontWeight: "700" },
  dim: { opacity: 0.78 },
  body: { marginTop: 6, lineHeight: 20 },
  footnote: { marginTop: 8 },
  warn: { color: "#8a5a00", fontWeight: "600" },
  divider: { marginVertical: 10 },
  red: { borderLeftWidth: 4, borderLeftColor: "#b3261e" },
  green: { borderLeftWidth: 4, borderLeftColor: "#2e7d32" },
});
