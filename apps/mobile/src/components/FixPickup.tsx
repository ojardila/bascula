/**
 * The screen that did not exist: fixing a weighing.
 *
 * Wilson puts 85 kg on the wrong person with the queue watching. Until this
 * dialog there was no path — `Pickups.remove` and `setWeight` were reachable
 * only from the review dialog under Reportes → Rendimiento, and that lists
 * only weighings that TRIPPED A RULE. The right weight on the wrong person
 * trips nothing: the number is plausible, the plot is plausible, the day is
 * today. So the mistake was invisible to the one screen that could fix it, and
 * the person who has to explain the short pay on Saturday is the pesador.
 *
 * One dialog for all three ways in — the row on «pesadas recientes», the row
 * on the home screen, and the review list — because there is one mistake and
 * a person should not have to know which door leads to which half of the fix.
 * The review list passes a `reason`; nothing else changes.
 *
 * It offers the three corrections that exist and no fourth: whose it is, how
 * much it was, and that it never happened. Moving it to another plot is not
 * offered on purpose — a load weighed on the wrong lote does not shortchange
 * anybody, and every control on this dialog costs a pesador a decision.
 */

import { useEffect, useMemo, useState } from "react";
import { StyleSheet, ScrollView } from "react-native";
import { Text, Portal, Dialog, Button, TextInput } from "react-native-paper";
import { People, Pickups } from "../db";
import { useT, formatDay } from "../i18n";
import ChipPicker from "./ChipPicker.tsx";

export interface FixablePickup {
  pickupId: number;
  personId: number;
  person: string;
  crop: string;
  date: string;
  weight: number;
  /** Why a rule raised it, when one did. Absent for an ordinary weighing. */
  reason?: string;
}

interface Props {
  pickup: FixablePickup | null;
  unit: string;
  onDismiss(): void;
  /** Something changed: reload, and say what happened. */
  onDone(message: string): void;
}

export default function FixPickup({ pickup, unit, onDismiss, onDone }: Props) {
  const { t, lang, num } = useT();
  const [weight, setWeight] = useState("");
  const [personId, setPersonId] = useState<number | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // Re-seeded every time a different row is opened. Without the reset the
  // dialog would open on the second row still holding the first row's weight,
  // which is a way of writing one person's kilos onto another.
  useEffect(() => {
    setWeight(pickup ? String(pickup.weight) : "");
    setPersonId(pickup?.personId ?? null);
    setConfirmingDiscard(false);
  }, [pickup?.pickupId, pickup?.weight, pickup?.personId]);

  // Read while the dialog is open rather than held in the parent: the list is
  // small, and a screen that has been in a pocket since this morning should
  // not offer a crew that has changed since.
  const people = useMemo(
    () =>
      pickup
        ? People.all().map((p) => ({
            id: p.id,
            label: `${p.name} ${p.lastName}`.trim(),
            tag: p.tag,
          }))
        : [],
    [pickup?.pickupId],
  );

  const typed = Number(weight.replace(",", "."));
  const movedPerson = !!pickup && personId != null && personId !== pickup.personId;
  const movedWeight = !!pickup && Number.isFinite(typed) && typed > 0 && typed !== pickup.weight;
  const canSave = movedPerson || movedWeight;

  function save() {
    if (!pickup || !canSave) return;
    try {
      // The person first. If the weight then turns out to be refused, the
      // reassignment — the correction that actually costs somebody money — is
      // already committed rather than lost with it.
      if (movedPerson) Pickups.setPerson(pickup.pickupId, personId!);
      if (movedWeight) Pickups.setWeight(pickup.pickupId, typed);
      const name = people.find((p) => p.id === personId)?.label ?? "";
      onDone(movedPerson ? t("fix.moved", { name }) : t("perf.corrected"));
    } catch (e) {
      onDone(explain(String(e)));
    }
  }

  function discard() {
    if (!pickup) return;
    try {
      Pickups.remove(pickup.pickupId);
      onDone(t("perf.discarded"));
    } catch (e) {
      onDone(explain(String(e)));
    }
  }

  function explain(message: string): string {
    if (message.includes("SETTLED")) return t("perf.settled");
    if (message.includes("BADWEIGHT")) return t("perf.badWeight");
    if (message.includes("NOPERSON")) return t("fix.noPerson");
    return t("pay.error");
  }

  return (
    <Portal>
      <Dialog
        visible={!!pickup}
        onDismiss={() => {
          setConfirmingDiscard(false);
          onDismiss();
        }}
      >
        <Dialog.Title>{confirmingDiscard ? t("pay.askDiscard") : t("fix.title")}</Dialog.Title>
        <Dialog.ScrollArea style={styles.area}>
          <ScrollView contentContainerStyle={styles.body}>
            <Text variant="bodyMedium">
              {pickup
                ? t("fix.what", {
                    weight: `${num(pickup.weight)} ${unit}`,
                    person: pickup.person,
                    crop: pickup.crop,
                    when: formatDay(pickup.date, lang),
                  })
                : ""}
            </Text>
            {!confirmingDiscard && !!pickup?.reason && (
              <Text variant="labelLarge" style={styles.reason}>
                {pickup.reason}
              </Text>
            )}

            {!confirmingDiscard && (
              <>
            <Text variant="titleSmall" style={styles.section}>
              {t("fix.whose")}
            </Text>
            <ChipPicker
              items={people}
              value={personId}
              onChange={setPersonId}
              icon="account-outline"
              searchLabel={t("pickup.search")}
              emptyLabel={t("pickup.noMatch")}
            />

            <Text variant="titleSmall" style={styles.section}>
              {t("fix.howMuch")}
            </Text>
            <TextInput
              mode="outlined"
              label={t("perf.newWeight", { unit })}
              keyboardType="decimal-pad"
              value={weight}
              onChangeText={setWeight}
              right={<TextInput.Affix text={unit} />}
            />
              </>
            )}
          </ScrollView>
        </Dialog.ScrollArea>
        <Dialog.Actions style={styles.actions}>
          {confirmingDiscard ? (
            <>
              <Button onPress={() => setConfirmingDiscard(false)}>{t("confirm.cancel")}</Button>
              <Button textColor="#b3261e" onPress={discard}>
                {t("pay.discardYes")}
              </Button>
            </>
          ) : (
            <>
              <Button onPress={onDismiss}>{t("perf.keep")}</Button>
              <Button textColor="#b3261e" onPress={() => setConfirmingDiscard(true)}>
                {t("perf.discard")}
              </Button>
              <Button mode="contained" disabled={!canSave} onPress={save}>
                {t("fix.save")}
              </Button>
            </>
          )}
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  // Bounded so the three buttons at the foot survive a crew of forty and a
  // keyboard: a save button off the bottom of a dialog is a save button that
  // does not exist.
  area: { maxHeight: 380, paddingHorizontal: 0 },
  body: { paddingHorizontal: 24, paddingVertical: 8, gap: 4 },
  reason: { color: "#8a5a00" },
  section: { marginTop: 14 },
  actions: { flexWrap: "wrap", gap: 4 },
});

/** The row shape every list already holds, turned into what this dialog needs. */
export function fixableFrom(r: {
  id: number;
  personId: number;
  person: string;
  crop: string;
  date: string;
  weight: number;
}): FixablePickup {
  return {
    pickupId: r.id,
    personId: r.personId,
    person: r.person,
    crop: r.crop,
    date: r.date,
    weight: r.weight,
  };
}
