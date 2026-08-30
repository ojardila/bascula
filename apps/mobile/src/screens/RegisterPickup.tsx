import { useCallback, useRef, useState } from "react";
import { ScrollView, StyleSheet } from "react-native";
import {
  Text,
  TextInput,
  Button,
  HelperText,
  Snackbar,
  Portal,
  Dialog,
} from "react-native-paper";
import { useFocusEffect } from "@react-navigation/native";
import { People, Crops, Pickups, Config, type Person, type Crop } from "../db";
import { useT } from "../i18n";
import ChipPicker from "../components/ChipPicker.tsx";
import { weightDoubt, type WeightDoubt } from "../pickupChecks.ts";

export default function RegisterPickup() {
  const { t, num } = useT();
  const [people, setPeople] = useState<Person[]>([]);
  const [crops, setCrops] = useState<Crop[]>([]);
  const [personId, setPersonId] = useState<number | null>(null);
  const [cropId, setCropId] = useState<number | null>(null);
  const [weight, setWeight] = useState("");
  const [unit, setUnit] = useState("kg");
  /** The saved weighing, while «Deshacer» can still reach it. */
  const [snack, setSnack] = useState<{ text: string; undo?: number } | null>(null);
  /** A weight worth asking about, held until somebody answers. */
  const [doubt, setDoubt] = useState<WeightDoubt | null>(null);

  useFocusEffect(
    useCallback(() => {
      setPeople(People.all());
      setCrops(Crops.all());
      setUnit(Config.get()?.unit || "kg");
    }, []),
  );

  const typed = parseFloat(weight.replace(",", "."));
  const valid = personId != null && cropId != null && typed > 0;
  const personName =
    people
      .filter((p) => p.id === personId)
      .map((p) => `${p.name} ${p.lastName}`.trim())[0] ?? "";

  // The app has a rule that flags two identical pickups within three minutes.
  // Better not to create them in the first place.
  const busy = useRef(false);

  /**
   * Ask before writing, when this person's own history says the number is odd.
   *
   * 850 for 85 used to be saved without a word, and the rule that catches it
   * lives two screens away under Reportes → Rendimiento — which means it is
   * found on Saturday, with the cash already counted. Asked HERE it costs one
   * tap and the picker is still standing at the scale.
   */
  function attempt() {
    if (busy.current || !valid) return;
    const d = weightDoubt(typed, Pickups.typical(personId!));
    if (d) {
      setDoubt(d);
      return;
    }
    save();
  }

  function save() {
    if (busy.current || !valid) return;
    busy.current = true;
    setDoubt(null);
    try {
      const r = Pickups.add({
        personId: personId!,
        cropId: cropId!,
        weight: typed,
        date: new Date().toISOString(),
      });
      setWeight("");
      setPersonId(null);
      // The lote is NOT cleared. The twenty people in the queue are in the
      // same one, and it changes once a day rather than two hundred times.
      // This was the cheapest change in the whole review.
      setSnack({ text: t("pickup.saved"), undo: r.lastInsertRowId });
    } finally {
      // Released even if the insert threw: this screen is a tab and never
      // unmounts, so a stuck flag would leave the button dead until restart.
      setTimeout(() => {
        busy.current = false;
      }, 400);
    }
  }

  /**
   * The eight seconds in which a wrong tap is still free.
   *
   * It is the same handle `PaymentsPanel` gives the crew payroll, and it is
   * here for the mistake nothing else catches: the right weight on the wrong
   * person, seen the instant the name appears on the snackbar. After the
   * snackbar goes, the row on «pesadas recientes» is the way back.
   */
  function undo(id: number) {
    try {
      Pickups.remove(id);
      setSnack(null);
      // Deferred: tapping the action also fires onDismiss, which would wipe a
      // message set in the same tick.
      setTimeout(() => setSnack({ text: t("pickup.undone") }), 0);
    } catch {
      setSnack(null);
      setTimeout(() => setSnack({ text: t("pay.error") }), 0);
    }
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text variant="titleMedium">{t("pickup.worker")}</Text>
        {people.length === 0 ? (
          <HelperText type="error" visible>
            {t("pickup.noWorkers")}
          </HelperText>
        ) : (
          <ChipPicker
            items={people.map((p) => ({
              id: p.id,
              label: `${p.name} ${p.lastName}`.trim(),
              tag: p.tag,
            }))}
            value={personId}
            onChange={setPersonId}
            icon="account-outline"
            searchLabel={t("pickup.search")}
            emptyLabel={t("pickup.noMatch")}
          />
        )}

        <Text variant="titleMedium" style={styles.mt}>
          {t("pickup.crop")}
        </Text>
        {crops.length === 0 ? (
          <HelperText type="error" visible>
            {t("pickup.noCrops")}
          </HelperText>
        ) : (
          <>
            <ChipPicker
              items={crops.map((c) => ({ id: c.id, label: c.name }))}
              value={cropId}
              onChange={setCropId}
              icon="sprout-outline"
              searchLabel={t("pickup.searchLot")}
              emptyLabel={t("pickup.noMatchLot")}
            />
            {cropId != null && (
              // Said out loud, because a field that does not clear looks like a
              // field that failed to clear.
              <Text variant="labelSmall" style={styles.kept}>
                {t("pickup.cropKept")}
              </Text>
            )}
          </>
        )}

        <TextInput
          label={t("pickup.weight", { unit })}
          value={weight}
          onChangeText={setWeight}
          mode="outlined"
          keyboardType="decimal-pad"
          style={styles.mt}
          right={<TextInput.Affix text={unit} />}
        />

        <Button
          mode="contained"
          icon="scale"
          disabled={!valid}
          onPress={attempt}
          style={styles.mt}
          contentStyle={{ paddingVertical: 6 }}
        >
          {t("pickup.save")}
        </Button>
      </ScrollView>

      <Portal>
        <Dialog visible={!!doubt} onDismiss={() => setDoubt(null)}>
          <Dialog.Icon icon="alert-outline" color="#8a5a00" />
          <Dialog.Title style={styles.doubtTitle}>{t("pickup.checkTitle")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium" style={styles.doubtBody}>
              {doubt?.rule === "digit"
                ? t("pickup.checkDigit", {
                    weight: `${num(typed)} ${unit}`,
                    person: personName,
                    typical: `${num(doubt.reference)} ${unit}`,
                  })
                : t("pickup.checkImpossible", {
                    weight: `${num(typed)} ${unit}`,
                    max: `${num(doubt?.reference ?? 0)} ${unit}`,
                  })}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDoubt(null)}>{t("pickup.checkNo")}</Button>
            <Button mode="contained" onPress={save}>
              {t("pickup.checkYes")}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar
        visible={!!snack}
        onDismiss={() => setSnack(null)}
        // Long enough to read a name, look up, and see the wrong face.
        duration={9000}
        action={
          snack?.undo != null
            ? { label: t("pay.undo"), onPress: () => undo(snack.undo!) }
            : undefined
        }
      >
        {snack?.text ?? ""}
      </Snackbar>
    </>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  mt: { marginTop: 16 },
  kept: { opacity: 0.75, marginTop: 6 },
  doubtTitle: { textAlign: "center" },
  doubtBody: { textAlign: "center", lineHeight: 21 },
});
