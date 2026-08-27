import { useCallback, useState } from "react";
import { ScrollView, View, StyleSheet } from "react-native";
import {
  Text,
  Card,
  Chip,
  TextInput,
  Button,
  HelperText,
  List,
  IconButton,
  Divider,
  Snackbar,
  SegmentedButtons,
} from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { CROP_PRESETS, presetByKey } from "../cropTypes";
import {
  Config,
  Overrides,
  Demo,
  Reports as ReportsDb,
  type CostOverride,
} from "../db";
import { useT, formatMoney, formatWeekRange, type Lang } from "../i18n";

export default function Settings() {
  const { t, lang, setLang } = useT();
  // Active crop config
  const [cropType, setCropType] = useState("cafe");
  const [label, setLabel] = useState("Café");
  const [unit, setUnit] = useState("kg");
  const [yieldUnit, setYieldUnit] = useState("kg por recolector");
  const [cost, setCost] = useState("800");

  // Weekly overrides
  const [overrides, setOverrides] = useState<CostOverride[]>([]);
  const [weeks, setWeeks] = useState<string[]>([]);
  const [ovWeek, setOvWeek] = useState<string>("");
  const [ovCost, setOvCost] = useState("");

  const [snack, setSnack] = useState("");

  const load = useCallback(() => {
    const c = Config.get();
    if (c) {
      setCropType(c.cropType);
      setLabel(c.label);
      setUnit(c.unit);
      setYieldUnit(c.yieldUnit);
      setCost(String(c.costPerUnit));
    }
    setOverrides(Overrides.all());
    const w = ReportsDb.byWeek().map((r) => r.label);
    setWeeks(w);
    if (!ovWeek && w.length) setOvWeek(w[0]);
  }, [ovWeek]);

  useFocusEffect(load);

  function choosePreset(key: string) {
    const p = presetByKey(key);
    setCropType(p.key);
    setLabel(p.label);
    setUnit(p.unit);
    setYieldUnit(p.yieldUnit);
    setCost(String(p.defaultCost));
  }

  function saveConfig() {
    Config.save({
      cropType,
      label,
      unit,
      yieldUnit,
      costPerUnit: Number(cost) || 0,
    });
    setSnack(t("settings.saved"));
  }

  function addOverride() {
    const c = Number(ovCost);
    if (!ovWeek || !c) {
      setSnack(t("settings.chooseWeekCost"));
      return;
    }
    Overrides.set(ovWeek, c);
    setOvCost("");
    setOverrides(Overrides.all());
    setSnack(t("settings.weekUpdated", { week: formatWeekRange(ovWeek, lang) }));
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Language */}
        <Card style={styles.card} mode="elevated">
          <Card.Title
            title={t("settings.languageTitle")}
            subtitle={t("settings.languageSub")}
            left={(p) => (
              <MaterialCommunityIcons {...p} name="translate" size={24} color="#2e7d32" />
            )}
          />
          <Card.Content>
            <SegmentedButtons
              value={lang}
              onValueChange={(v) => setLang(v as Lang)}
              buttons={[
                { value: "es", label: "Español" },
                { value: "en", label: "English" },
                { value: "pt", label: "Português" },
              ]}
            />
          </Card.Content>
        </Card>

        {/* Crop type */}
        <Card style={styles.card} mode="elevated">
          <Card.Title
            title={t("settings.cropTypeTitle")}
            subtitle={t("settings.cropTypeSub")}
            left={(p) => (
              <MaterialCommunityIcons {...p} name="sprout" size={24} color="#2e7d32" />
            )}
          />
          <Card.Content>
            <View style={styles.chips}>
              {CROP_PRESETS.map((p) => (
                <Chip
                  key={p.key}
                  icon={p.icon}
                  selected={cropType === p.key}
                  showSelectedOverlay
                  onPress={() => choosePreset(p.key)}
                  style={styles.chip}
                >
                  {p.label}
                </Chip>
              ))}
            </View>
          </Card.Content>
        </Card>

        {/* Units + general cost */}
        <Card style={styles.card} mode="elevated">
          <Card.Title
            title={t("settings.unitsTitle")}
            left={(p) => (
              <MaterialCommunityIcons {...p} name="ruler" size={24} color="#2e7d32" />
            )}
          />
          <Card.Content style={{ gap: 8 }}>
            <TextInput
              mode="outlined"
              label={t("settings.cropName")}
              value={label}
              onChangeText={setLabel}
            />
            <TextInput
              mode="outlined"
              label={t("settings.unit")}
              placeholder={t("settings.unitPlaceholder")}
              value={unit}
              onChangeText={setUnit}
            />
            <TextInput
              mode="outlined"
              label={t("settings.yieldUnit")}
              value={yieldUnit}
              onChangeText={setYieldUnit}
            />
            <TextInput
              mode="outlined"
              label={t("settings.generalCost", { unit: unit || t("unit.default") })}
              keyboardType="numeric"
              left={<TextInput.Affix text="$" />}
              value={cost}
              onChangeText={setCost}
            />
            <HelperText type="info" visible>
              {t("settings.generalCostHelp")}
            </HelperText>
            <Button mode="contained" icon="content-save" onPress={saveConfig}>
              {t("settings.saveConfig")}
            </Button>
          </Card.Content>
        </Card>

        {/* Weekly cost overrides */}
        <Card style={styles.card} mode="elevated">
          <Card.Title
            title={t("settings.weekCostsTitle")}
            subtitle={t("settings.weekCostsSub")}
            left={(p) => (
              <MaterialCommunityIcons {...p} name="calendar-edit" size={24} color="#2e7d32" />
            )}
          />
          <Card.Content style={{ gap: 8 }}>
            {weeks.length === 0 ? (
              <Text style={styles.empty}>{t("settings.noWeeks")}</Text>
            ) : (
              <>
                <Text variant="labelLarge" style={{ opacity: 0.7 }}>
                  {t("settings.week")}
                </Text>
                <View style={styles.chips}>
                  {weeks.map((w) => (
                    <Chip
                      key={w}
                      selected={ovWeek === w}
                      showSelectedOverlay
                      onPress={() => setOvWeek(w)}
                      style={styles.chip}
                    >
                      {formatWeekRange(w, lang)}
                    </Chip>
                  ))}
                </View>
                <View style={styles.ovRow}>
                  <TextInput
                    mode="outlined"
                    label={t("settings.costPer", { unit: unit || t("unit.default") })}
                    keyboardType="numeric"
                    left={<TextInput.Affix text="$" />}
                    value={ovCost}
                    onChangeText={setOvCost}
                    style={{ flex: 1 }}
                  />
                  <Button mode="contained-tonal" icon="plus" onPress={addOverride}>
                    {t("settings.add")}
                  </Button>
                </View>
              </>
            )}

            {overrides.length > 0 && (
              <View style={{ marginTop: 4 }}>
                {overrides.map((o, i) => (
                  <View key={o.id}>
                    {i > 0 && <Divider />}
                    <List.Item
                      title={formatWeekRange(o.week, lang)}
                      description={`${formatMoney(o.costPerUnit)} · ${unit || t("unit.default")}`}
                      left={(p) => <List.Icon {...p} icon="calendar-week" />}
                      right={(p) => (
                        <IconButton
                          {...p}
                          icon="delete-outline"
                          onPress={() => {
                            Overrides.remove(o.id);
                            setOverrides(Overrides.all());
                          }}
                        />
                      )}
                    />
                  </View>
                ))}
              </View>
            )}
          </Card.Content>
        </Card>

        {/* Demo data */}
        <Card style={styles.card} mode="elevated">
          <Card.Title
            title={t("settings.demoTitle")}
            subtitle={t("settings.demoSub")}
            left={(p) => (
              <MaterialCommunityIcons {...p} name="database-cog" size={24} color="#2e7d32" />
            )}
          />
          <Card.Content style={styles.demoRow}>
            <Button
              mode="contained"
              icon="database-import"
              style={{ flex: 1 }}
              onPress={() => {
                Demo.seed();
                load();
                setSnack(t("settings.demoLoaded"));
              }}
            >
              {t("settings.loadDemo")}
            </Button>
            <Button
              mode="outlined"
              icon="delete-sweep"
              textColor="#b3261e"
              onPress={() => {
                Demo.clear();
                load();
                setSnack(t("settings.cleared"));
              }}
            >
              {t("settings.clearAll")}
            </Button>
          </Card.Content>
        </Card>
      </ScrollView>

      <Snackbar visible={!!snack} onDismiss={() => setSnack("")} duration={2200}>
        {snack}
      </Snackbar>
    </>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 14 },
  card: { borderRadius: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {},
  empty: { opacity: 0.6, paddingVertical: 8 },
  ovRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  demoRow: { flexDirection: "row", gap: 8, alignItems: "center" },
});
