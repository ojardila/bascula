import { useRef, useState } from "react";
import { ScrollView, View, StyleSheet } from "react-native";
import { TextInput, Button, Chip, Text, HelperText } from "react-native-paper";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import { Crops as CropsDb, Config } from "../db";
import { CROP_PRESETS, presetByKey } from "../cropTypes";
import { useT } from "../i18n";

export default function CropAdd({
  navigation,
}: NativeStackScreenProps<RootStackParamList, "CropAdd">) {
  const { t } = useT();
  // Preselect the crop type configured in Settings.
  const initialType = Config.get()?.cropType ?? "cafe";
  const [type, setType] = useState(initialType);
  const [name, setName] = useState("");
  const [variety, setVariety] = useState("");
  const [dimension, setDimension] = useState("");

  const preset = presetByKey(type);
  const valid = name.trim().length > 0 && !!type;

  const busy = useRef(false);

  function save() {
    if (busy.current) return;
    busy.current = true;
    CropsDb.add({
      name: name.trim(),
      type: preset.label, // store the readable crop-type label
      variety,
      dimension: parseFloat(dimension) || 0,
    });
    navigation.goBack();
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text variant="labelLarge" style={styles.section}>
        {t("cropAdd.type")}
      </Text>
      <View style={styles.chips}>
        {CROP_PRESETS.map((p) => (
          <Chip
            key={p.key}
            icon={p.icon}
            selected={type === p.key}
            showSelectedOverlay
            onPress={() => setType(p.key)}
          >
            {p.label}
          </Chip>
        ))}
      </View>
      <HelperText type="info" visible>
        {t("cropAdd.measuredIn", { unit: preset.unit, yield: preset.yieldUnit })}
      </HelperText>

      <TextInput
        label={t("cropAdd.lotName")}
        placeholder={t("cropAdd.lotPlaceholder", { label: preset.label })}
        value={name}
        onChangeText={setName}
        mode="outlined"
      />
      <TextInput label={t("cropAdd.variety")} value={variety} onChangeText={setVariety} mode="outlined" />
      <TextInput
        label={t("cropAdd.area")}
        value={dimension}
        onChangeText={setDimension}
        mode="outlined"
        keyboardType="decimal-pad"
      />
      <Button mode="contained" icon="content-save" disabled={!valid} onPress={save}>
        {t("cropAdd.save")}
      </Button>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12 },
  section: { opacity: 0.7 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
