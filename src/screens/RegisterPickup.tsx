import { useCallback, useState } from "react";
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

  function save() {
    if (!valid) return;
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
                showSelectedCheck
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
                showSelectedCheck
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
