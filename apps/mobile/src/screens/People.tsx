import { useCallback, useMemo, useState } from "react";
import { View, FlatList, StyleSheet } from "react-native";
import {
  List,
  FAB,
  SegmentedButtons,
  Text,
  TextInput,
  Avatar,
} from "react-native-paper";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList, TabParamList } from "../types";
import { People as PeopleDb, type Person } from "../db";
import { useT } from "../i18n";
import { matches } from "../pickupChecks.ts";
import PaymentsPanel from "./PaymentsPanel";

export default function People() {
  const { t } = useT();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [items, setItems] = useState<Person[]>([]);
  const [query, setQuery] = useState("");
  // Payments live here rather than in a seventh tab: at 360dp a seventh item
  // drops each tab under the 48dp touch target and truncates every label.
  const route = useRoute<RouteProp<TabParamList, "People">>();
  const openAs = route.params?.view;
  const [view, setView] = useState<"people" | "pay">(openAs === "pay" ? "pay" : "people");
  const load = useCallback(() => setItems(PeopleDb.all()), []);
  useFocusEffect(load);
  // The tab stays mounted. Home's { view: "pay" } only landed on first mount.
  useFocusEffect(
    useCallback(() => {
      if (openAs === "pay") {
        setView("pay");
        navigation.setParams({ view: undefined } as never);
      }
    }, [openAs, navigation]),
  );

  const shown = useMemo(() => {
    if (!query.trim()) return items;
    return items.filter((p) =>
      matches({ label: `${p.name} ${p.lastName}`.trim(), tag: p.tag }, query),
    );
  }, [items, query]);

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
      {items.length >= 8 && (
        <TextInput
          mode="outlined"
          label={t("pickup.search")}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          autoCapitalize="none"
          left={<TextInput.Icon icon="magnify" />}
          right={
            query ? <TextInput.Icon icon="close" onPress={() => setQuery("")} /> : undefined
          }
          style={styles.search}
        />
      )}
      <FlatList
        data={shown}
        keyExtractor={(i) => String(i.id)}
        contentContainerStyle={shown.length ? undefined : styles.emptyWrap}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {query ? t("pickup.noMatch") : t("people.empty")}
          </Text>
        }
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
          />
        )}
      />
      <FAB icon="plus" style={styles.fab} onPress={() => navigation.navigate("PeopleAdd")} />
      </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  switch: { margin: 12 },
  search: { marginHorizontal: 12, marginBottom: 4, minHeight: 48 },
  fab: { position: "absolute", right: 16, bottom: 16 },
  avatar: { marginLeft: 8, alignSelf: "center" },
  emptyWrap: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
  empty: { opacity: 0.7, padding: 24, textAlign: "center" },
});
