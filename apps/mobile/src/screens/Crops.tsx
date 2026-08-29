import { useCallback, useState } from "react";
import { View, FlatList, StyleSheet } from "react-native";
import { List, FAB, Text, IconButton, Portal, Dialog, Button } from "react-native-paper";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import { Crops as CropsDb, type Crop } from "../db";
import { useT } from "../i18n";
import { useSync } from "../sync/SyncProvider";

export default function Crops() {
  // Decision 6: lotes are administered on the web. Two pesadores creating
  // "Lote 1" and "lote 1" on the same morning is a merge no script can do
  // afterwards, and merging lotes is the owner's work with a screen, not a
  // guess. The cost is real and it is said out loud on the sync screen: a new
  // lote mid-harvest now needs somebody at a computer.
  const { status: syncStatus } = useSync();
  const { t } = useT();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [items, setItems] = useState<Crop[]>([]);
  const [pending, setPending] = useState<Crop | null>(null); // plot awaiting delete confirm
  const load = useCallback(() => setItems(CropsDb.all()), []);
  useFocusEffect(load);

  return (
    <View style={styles.container}>
      <FlatList
        data={items}
        keyExtractor={(i) => String(i.id)}
        contentContainerStyle={items.length ? undefined : styles.emptyWrap}
        ListEmptyComponent={<Text style={styles.empty}>{t("crops.empty")}</Text>}
        renderItem={({ item }) => (
          <List.Item
            onPress={() => navigation.navigate("CropDetail", { cropId: item.id })}
            title={item.name}
            description={[item.type, item.variety, item.dimension ? `${item.dimension} ha` : ""]
              .filter(Boolean)
              .join(" · ")}
            left={(p) => <List.Icon {...p} icon="sprout" />}
            right={(p) => (
              <IconButton
                {...p}
                icon="delete-outline"
                onPress={() => setPending(item)}
              />
            )}
          />
        )}
      />
      {!syncStatus.registered && (
        <FAB icon="plus" style={styles.fab} onPress={() => navigation.navigate("CropAdd")} />
      )}

      <Portal>
        <Dialog visible={!!pending} onDismiss={() => setPending(null)}>
          <Dialog.Icon icon="sprout-outline" />
          <Dialog.Title style={styles.dialogTitle}>{t("confirm.deleteCropTitle")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium" style={{ textAlign: "center" }}>
              {pending?.name ?? ""}
            </Text>
            <Text variant="bodySmall" style={styles.dialogBody}>
              {t("confirm.deleteCropBody")}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setPending(null)}>{t("confirm.cancel")}</Button>
            <Button
              textColor="#b3261e"
              onPress={() => {
                if (pending) {
                  CropsDb.remove(pending.id);
                  setPending(null);
                  load();
                }
              }}
            >
              {t("confirm.delete")}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  fab: { position: "absolute", right: 16, bottom: 16 },
  emptyWrap: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
  dialogTitle: { textAlign: "center" },
  dialogBody: { textAlign: "center", opacity: 0.7, marginTop: 8 },
  empty: { opacity: 0.6, padding: 24, textAlign: "center" },
});
