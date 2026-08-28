import { useCallback, useRef, useState } from "react";
import { ScrollView, View, StyleSheet } from "react-native";
import { Text, TextInput, Button, Chip, HelperText, Snackbar } from "react-native-paper";
import { useFocusEffect } from "@react-navigation/native";
import { People, Crops, Pickups, Config, type Person, type Crop } from "../db";
import { useT } from "../i18n";

export default function RegisterPickup() {
  const { t } = useT();
  const [people, setPeople] = useState<Person[]>([]);
  const [crops, setCrops] = useState<Crop[]>([]);
  const [personId, setPersonId] = useState<number | null>(null);
  const [cropId, setCropId] = useState<number | null>(null);
  const [weight, setWeight] = useState("");
  const [unit, setUnit] = useState("kg");
  const [saved, setSaved] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setPeople(People.all());
      setCrops(Crops.all());
      setUnit(Config.get()?.unit || "kg");
    }, []),
  );

  const valid = personId != null && cropId != null && parseFloat(weight) > 0;

  // The app has a rule that flags two identical pickups within three minutes.
  // Better not to create them in the first place.
  const busy = useRef(false);

  function save() {
    if (busy.current || !valid) return;
    busy.current = true;
    try {
      Pickups.add({
        personId: personId!,
        cropId: cropId!,
        weight: parseFloat(weight),
        date: new Date().toISOString(),
      });
      setWeight("");
      setPersonId(null);
      setCropId(null);
      setSaved(true);
    } finally {
      // Released even if the insert threw: this screen is a tab and never
      // unmounts, so a stuck flag would leave the button dead until restart.
      setTimeout(() => {
        busy.current = false;
      }, 400);
    }
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        <Text variant="titleMedium">{t("pickup.worker")}</Text>
        {people.length === 0 ? (
          <HelperText type="error" visible>
            {t("pickup.noWorkers")}
          </HelperText>
        ) : (
          <View style={styles.chips}>
            {people.map((p) => (
              <Chip
                key={p.id}
                selected={personId === p.id}
                showSelectedCheck={false}
                icon={personId === p.id ? "check" : "account-outline"}
                onPress={() => setPersonId(p.id)}
              >
                {`${p.name} ${p.lastName}`.trim()}
              </Chip>
            ))}
          </View>
        )}

        <Text variant="titleMedium" style={styles.mt}>
          {t("pickup.crop")}
        </Text>
        {crops.length === 0 ? (
          <HelperText type="error" visible>
            {t("pickup.noCrops")}
          </HelperText>
        ) : (
          <View style={styles.chips}>
            {crops.map((c) => (
              <Chip
                key={c.id}
                selected={cropId === c.id}
                showSelectedCheck={false}
                icon={cropId === c.id ? "check" : "sprout-outline"}
                onPress={() => setCropId(c.id)}
              >
                {c.name}
              </Chip>
            ))}
          </View>
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
          onPress={save}
          style={styles.mt}
          contentStyle={{ paddingVertical: 6 }}
        >
          {t("pickup.save")}
        </Button>
      </ScrollView>

      <Snackbar visible={saved} onDismiss={() => setSaved(false)} duration={2200}>
        {t("pickup.saved")}
      </Snackbar>
    </>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  mt: { marginTop: 16 },
});
