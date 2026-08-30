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
  Dialog,
  Portal,
} from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { CROP_PRESETS, presetByKey } from "../cropTypes";
import {
  Config,
  Overrides,
  Demo,
  Export,
  Reports as ReportsDb,
  ConfirmationRequired,
  type CostOverride,
} from "../db";
import { csvDocument } from "../csv";
import { useT, formatWeekRange, type Lang } from "../i18n";
import { useSync } from "../sync/SyncProvider";

export default function Settings() {
  // Decision 6: the weekly price is the owner's, on the web. Once this phone
  // belongs to a farm it reads the price and does not set it — because a price
  // edited in two places with "last one wins" reprices a whole farm's week,
  // and there is no conflict to resolve there, there is a payroll.
  const { status: syncStatus } = useSync();
  const priceIsReadOnly = syncStatus.registered;
  const { t, lang, setLang, money } = useT();
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
      costPerUnit: priceIsReadOnly
        ? (Config.get()?.costPerUnit ?? 0)
        : Number(cost) || 0,
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

  const [exporting, setExporting] = useState(false);

  // Wiping the farm.
  //
  // `Demo.clear` was one unguarded tap in this screen, next to "load demo",
  // on the phone that holds the only copy of the season
  // (`docs/diagramas/movil.md` §9.15). It now needs the farm's own name typed
  // out — and so does "load demo", which begins by wiping.
  //
  // A name to type rather than a build-time guard: hiding the buttons in
  // production would leave a farm that genuinely needs to start over — a new
  // season, a phone handed on, a demo loaded on day one by mistake — with no
  // way out but reinstalling, which loses the CSV export path too. Typing the
  // name cannot happen by accident with gloves on, and the guard lives in the
  // data layer where a test can reach it, not in this component.
  const [wipe, setWipe] = useState<null | "clear" | "seed">(null);
  const [wipeName, setWipeName] = useState("");
  const [wipeError, setWipeError] = useState(false);

  function askToWipe(what: "clear" | "seed") {
    setWipeName("");
    setWipeError(false);
    setWipe(what);
  }

  function confirmWipe() {
    if (!wipe) return;
    try {
      if (wipe === "seed") Demo.seed(wipeName);
      else Demo.clear(wipeName);
      setWipe(null);
      load();
      setSnack(t(wipe === "seed" ? "settings.demoLoaded" : "settings.cleared"));
    } catch (e) {
      // The only expected failure is the name not matching; anything else is
      // a real error and must not be reported as a typo.
      if (e instanceof ConfirmationRequired) setWipeError(true);
      else {
        setWipe(null);
        setSnack(t("settings.exportFailed"));
      }
    }
  }

  // One button per set rather than one that exports everything: chaining
  // three sharing sheets forced the user through two they had not asked for,
  // with no way out but closing them all. The three answer different
  // questions anyway, so pick the one you need.
  const EXPORTS = [
    { key: "pesadas", label: "settings.exportPickups", rows: () => Export.pickups() },
    { key: "movimientos", label: "settings.exportLedger", rows: () => Export.ledger() },
    { key: "saldos", label: "settings.exportBalances", rows: () => Export.balances() },
  ] as const;

  async function exportCsv(name: string, rows: Record<string, unknown>[]) {
    if (exporting) return;
    setExporting(true);
    try {
      if (!rows.length) {
        setSnack(t("settings.exportEmpty"));
        return;
      }
      const header = Object.keys(rows[0]);
      const csv = csvDocument(
        header,
        rows.map((r) => header.map((h) => r[h])),
      );
      const stamp = new Date().toISOString().slice(0, 10);
      const file = new File(Paths.cache, `bascula-${name}-${stamp}.csv`);
      file.create({ overwrite: true });
      file.write(csv);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: "text/csv" });
      }
    } catch {
      setSnack(t("settings.exportFailed"));
    } finally {
      setExporting(false);
    }
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
              editable={!priceIsReadOnly}
              disabled={priceIsReadOnly}
            />
            <HelperText type="info" visible>
              {priceIsReadOnly ? t("sync.changePrices") : t("settings.generalCostHelp")}
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
            {priceIsReadOnly ? (
              <Text style={styles.empty}>{t("sync.changePrices")}</Text>
            ) : weeks.length === 0 ? (
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
                      description={`${money(o.costPerUnit)} · ${unit || t("unit.default")}`}
                      left={(p) => <List.Icon {...p} icon="calendar-week" />}
                      right={(p) =>
                        priceIsReadOnly ? null : (
                          <IconButton
                            {...p}
                            icon="delete-outline"
                            onPress={() => {
                              Overrides.remove(o.id);
                              setOverrides(Overrides.all());
                            }}
                          />
                        )
                      }
                    />
                  </View>
                ))}
              </View>
            )}
          </Card.Content>
        </Card>

        {/* Export */}
        <Card style={styles.card} mode="elevated">
          <Card.Title
            title={t("settings.exportTitle")}
            subtitle={t("settings.exportSub")}
            left={(p) => (
              <MaterialCommunityIcons {...p} name="tray-arrow-up" size={24} color="#2e7d32" />
            )}
          />
          <Card.Content style={styles.exportRow}>
            {EXPORTS.map((e) => (
              <Button
                key={e.key}
                mode="outlined"
                icon="file-delimited"
                disabled={exporting}
                onPress={() => exportCsv(e.key, e.rows() as Record<string, unknown>[])}
              >
                {t(e.label)}
              </Button>
            ))}
          </Card.Content>
        </Card>

        {/*
          §2: hidden once the phone belongs to a farm. `seed` begins by wiping,
          and a wipe on a synced farm is a catastrophe with a button on it —
          the rows go, the outbox goes with them, and the next pull brings back
          a hollow copy of a season nobody can reconcile. The guard that
          demands the farm's own name typed out stays underneath; this only
          stops the button being somewhere a thumb can find it at eleven at
          night.
        */}
        {!syncStatus.registered && (
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
              onPress={() => askToWipe("seed")}
            >
              {t("settings.loadDemo")}
            </Button>
            <Button
              mode="outlined"
              icon="delete-sweep"
              textColor="#b3261e"
              onPress={() => askToWipe("clear")}
            >
              {t("settings.clearAll")}
            </Button>
          </Card.Content>
        </Card>
        )}
      </ScrollView>

      <Portal>
        <Dialog visible={!!wipe} onDismiss={() => setWipe(null)}>
          <Dialog.Title>{t("settings.wipeTitle")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {t(wipe === "seed" ? "settings.wipeSeedBody" : "settings.wipeClearBody")}
            </Text>
            <TextInput
              mode="outlined"
              style={{ marginTop: 12 }}
              label={t("settings.wipeField")}
              placeholder={Demo.clearToken()}
              value={wipeName}
              onChangeText={(v) => {
                setWipeName(v);
                setWipeError(false);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              error={wipeError}
            />
            <HelperText type={wipeError ? "error" : "info"} visible>
              {wipeError
                ? t("settings.wipeMismatch")
                : t("settings.wipeConfirm", { name: Demo.clearToken() })}
            </HelperText>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setWipe(null)}>{t("settings.wipeCancel")}</Button>
            <Button textColor="#b3261e" onPress={confirmWipe}>
              {t(wipe === "seed" ? "settings.loadDemo" : "settings.clearAll")}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

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
  empty: { opacity: 0.7, paddingVertical: 8 },
  ovRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  exportRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  demoRow: { flexDirection: "row", gap: 8, alignItems: "center" },
});
