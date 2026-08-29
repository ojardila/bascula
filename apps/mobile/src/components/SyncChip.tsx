/**
 * §7.1 — one chip, in the header, always visible, tappable.
 *
 * Four states, and none of them is a spinner on its own. A spinner tells the
 * pesador that something is happening; the number tells them whether their
 * work is safe, which is the only question they are actually asking.
 *
 * Only the conflict state is red. That is the whole discipline of the thing:
 * a colour that means "look at me now" stops meaning anything the moment two
 * different situations wear it.
 */

import { StyleSheet, Pressable, View } from "react-native";
import { Text, ActivityIndicator } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../types";
import { useT } from "../i18n";
import { useSync, type SyncTone } from "../sync/SyncProvider";

const TONE: Record<SyncTone, { bg: string; fg: string; icon: string }> = {
  ok: { bg: "rgba(255,255,255,0.18)", fg: "#ffffff", icon: "cloud-check-outline" },
  pending: { bg: "rgba(255,255,255,0.18)", fg: "#ffffff", icon: "cloud-upload-outline" },
  offline: { bg: "#fff3d6", fg: "#8a5a00", icon: "cloud-off-outline" },
  conflict: { bg: "#fde7e5", fg: "#b3261e", icon: "alert-circle" },
};

export default function SyncChip() {
  const { t } = useT();
  const { status } = useSync();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  // Before the phone belongs to a farm the chip is an invitation, not a
  // status: there is nothing to be behind on.
  const tone = status.registered ? status.tone : "pending";
  const skin = TONE[tone];

  const label = !status.registered
    ? t("sync.connectShort")
    : status.conflicts > 0
      ? t("sync.chipConflicts", { n: status.conflicts })
      : // "Sin señal · 12 pendientes" only says something when there ARE
        // pendientes. A phone whose token was revoked, or whose farm was
        // suspended, has an empty outbox and used to read "Sincronizado" —
        // green, in the header, while receiving nothing for days.
        status.tone === "offline"
        ? status.pending > 0
          ? t("sync.chipOffline", { n: status.pending })
          : t("sync.chipStuck")
        : status.pending > 0
          ? t("sync.chipPending", { n: status.pending })
          : // Nothing to send, and still not up to date: the pull stopped with
            // the server holding more. §6.1 turns the settle button off for
            // this, so the chip cannot claim otherwise.
            status.stillBehind
            ? t("sync.chipBehind")
            : t("sync.chipOk");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() =>
        navigation.navigate(status.registered ? "SyncStatus" : "SyncSetup")
      }
      style={[styles.chip, { backgroundColor: skin.bg }]}
      hitSlop={8}
    >
      <View style={styles.row}>
        {status.busy ? (
          <ActivityIndicator size={13} color={skin.fg} />
        ) : (
          <MaterialCommunityIcons name={skin.icon as never} size={15} color={skin.fg} />
        )}
        <Text style={[styles.text, { color: skin.fg }]} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, marginRight: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 5 },
  text: { fontSize: 12, fontWeight: "700", maxWidth: 140 },
});
