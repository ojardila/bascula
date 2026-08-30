import { useCallback, useState } from "react";
import { View, FlatList, StyleSheet } from "react-native";
import {
  List,
  FAB,
  SegmentedButtons,
  Text,
  IconButton,
  Avatar,
  Portal,
  Dialog,
  Button,
} from "react-native-paper";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList, TabParamList } from "../types";
import { People as PeopleDb, type Person } from "../db";
import { useT } from "../i18n";
import PaymentsPanel from "./PaymentsPanel";

export default function People() {
  const { t } = useT();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [items, setItems] = useState<Person[]>([]);
  const [pending, setPending] = useState<Person | null>(null); // worker awaiting delete confirm
  // Payments live here rather than in a seventh tab: at 360dp a seventh item
  // drops each tab under the 48dp touch target and truncates every label.
  const openAs = useRoute<RouteProp<TabParamList, "People">>().params?.view;
  const [view, setView] = useState<"people" | "pay">(openAs === "pay" ? "pay" : "people");
  const load = useCallback(() => setItems(PeopleDb.all()), []);
  useFocusEffect(load);

  function confirmDelete() {
    if (pending) {
      PeopleDb.remove(pending.id);
      setPending(null);
      load();
    }
  }

  return (
    <View style={styles.container}>
      <SegmentedButtons
        value={view}
        onValueChange={(v) => setView(v as "people" | "pay")}
        style={styles.switch}
        buttons={[
          { value: "people", label: t("nav.workers"), icon: "account-group" },
          { value: "pay", label: t("pay.tab"), icon: "cash-multiple" },
        ]}
      />
      {view === "pay" ? (
        <PaymentsPanel />
      ) : (
      <>
      <FlatList
        data={items}
        keyExtractor={(i) => String(i.id)}
        contentContainerStyle={items.length ? undefined : styles.emptyWrap}
        ListEmptyComponent={<Text style={styles.empty}>{t("people.empty")}</Text>}
        renderItem={({ item }) => (
          <List.Item
            onPress={() => navigation.navigate("WorkerDetail", { personId: item.id })}
            title={`${item.name} ${item.lastName}`.trim()}
            description={`${item.documentType || ""} ${item.docId || ""} · ${t("people.tag")} ${item.tag || "—"}`}
            left={() =>
              item.image ? (
                <Avatar.Image size={44} source={{ uri: item.image }} style={styles.avatar} />
              ) : (
                <Avatar.Icon size={44} icon="account" style={styles.avatar} />
              )
            }
            right={(p) => (
              <IconButton {...p} icon="delete-outline" onPress={() => setPending(item)} />
            )}
          />
        )}
      />
      <FAB icon="plus" style={styles.fab} onPress={() => navigation.navigate("PeopleAdd")} />
      </>
      )}

      <Portal>
        <Dialog visible={!!pending} onDismiss={() => setPending(null)}>
          <Dialog.Icon icon="account-off" />
          <Dialog.Title style={styles.dialogTitle}>
            {t("confirm.deleteWorkerTitle")}
          </Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium" style={{ textAlign: "center" }}>
              {pending ? `${pending.name} ${pending.lastName}`.trim() : ""}
            </Text>
            <Text variant="bodySmall" style={styles.dialogBody}>
              {t("confirm.deleteWorkerBody")}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setPending(null)}>{t("confirm.cancel")}</Button>
            <Button textColor="#b3261e" onPress={confirmDelete}>
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
  switch: { margin: 12 },
  fab: { position: "absolute", right: 16, bottom: 16 },
  avatar: { marginLeft: 8, alignSelf: "center" },
  emptyWrap: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
  empty: { opacity: 0.7, padding: 24, textAlign: "center" },
  dialogTitle: { textAlign: "center" },
  dialogBody: { textAlign: "center", opacity: 0.7, marginTop: 8 },
});
