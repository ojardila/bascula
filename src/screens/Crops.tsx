import { useCallback, useState } from "react";
import { View, FlatList, StyleSheet } from "react-native";
import { List, FAB, Text, IconButton } from "react-native-paper";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../types";
import { Crops as CropsDb, type Crop } from "../db";
import { useT } from "../i18n";

export default function Crops() {
  const { t } = useT();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [items, setItems] = useState<Crop[]>([]);
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
            title={item.name}
            description={[item.type, item.variety, item.dimension ? `${item.dimension} ha` : ""]
              .filter(Boolean)
              .join(" · ")}
            left={(p) => <List.Icon {...p} icon="sprout" />}
            right={(p) => (
              <IconButton
                {...p}
                icon="delete-outline"
                onPress={() => {
                  CropsDb.remove(item.id);
                  load();
                }}
              />
            )}
          />
        )}
      />
      <FAB icon="plus" style={styles.fab} onPress={() => navigation.navigate("CropAdd")} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  fab: { position: "absolute", right: 16, bottom: 16 },
  emptyWrap: { flexGrow: 1, justifyContent: "center", alignItems: "center" },
  empty: { opacity: 0.6, padding: 24, textAlign: "center" },
});
