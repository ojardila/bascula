/**
 * Registering the phone against a farm.
 *
 * One screen, two fields, one button. The owner types the credentials they
 * already use on the web; the phone exchanges them for a token pair and
 * forgets the password immediately (see `sync/session.ts` — it is never
 * stored, in any form).
 *
 * What is deliberately NOT here: a field for the server address. A text box
 * for a URL is a text box somebody eventually points at the wrong farm, and
 * the failure mode is one farm's weighings landing in another's payroll.
 */

import { useState } from "react";
import { View, ScrollView, StyleSheet } from "react-native";
import {
  Text,
  Card,
  Button,
  TextInput,
  HelperText,
  ActivityIndicator,
  List,
} from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { useT } from "../i18n";
import { repository } from "../db";
import { useSync } from "../sync/SyncProvider";
import { ApiError } from "../sync/http";

export default function SyncSetup() {
  const { t } = useT();
  const { status, register, syncNow, signOut } = useSync();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const identity = repository.sync.identity();

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await register(email, password);
    } catch (e) {
      setError(messageFor(e, t));
    } finally {
      setBusy(false);
    }
  }

  if (status.registered) {
    return (
      <ScrollView contentContainerStyle={styles.scroll}>
        <Card mode="elevated" style={styles.card}>
          <Card.Content style={styles.centered}>
            <MaterialCommunityIcons name="check-decagram" size={44} color="#2e7d32" />
            <Text variant="titleLarge" style={styles.title}>
              {status.farmName}
            </Text>
            <Text style={styles.dim}>{t("sync.registeredAs", { role: roleName(status.role, t) })}</Text>
          </Card.Content>
        </Card>

        <Card mode="elevated" style={styles.card}>
          <Card.Content>
            {/* The device's own name, shown because it is what a support call
                needs and because a farm with two handsets has to be able to
                tell them apart. */}
            <List.Item
              title={t("sync.deviceId")}
              description={identity.deviceId.slice(0, 8)}
              left={(p) => <List.Icon {...p} icon="cellphone" />}
            />
            <List.Item
              title={t("sync.farmId")}
              description={identity.farmId?.slice(0, 8) ?? "—"}
              left={(p) => <List.Icon {...p} icon="barn" />}
            />
          </Card.Content>
        </Card>

        <Button mode="contained" icon="sync" onPress={() => void syncNow()} style={styles.button}>
          {t("sync.syncNow")}
        </Button>

        {/*
          Signing out drops the tokens and nothing else. The season stays on
          the phone — it is the only copy — and the outbox keeps every row it
          still owes, so signing back in resumes rather than restarts.
        */}
        <Button mode="text" icon="logout" onPress={signOut} style={styles.button}>
          {t("sync.signOut")}
        </Button>
        <HelperText type="info" visible>
          {t("sync.signOutNote")}
        </HelperText>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Card mode="elevated" style={styles.card}>
        <Card.Content style={{ gap: 12 }}>
          <Text variant="titleMedium">{t("sync.connectTitle")}</Text>
          <Text style={styles.dim}>{t("sync.connectBody")}</Text>

          <TextInput
            mode="outlined"
            label={t("sync.email")}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            left={<TextInput.Icon icon="email" />}
          />
          <TextInput
            mode="outlined"
            label={t("sync.password")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            left={<TextInput.Icon icon="lock" />}
          />

          {!!error && (
            <HelperText type="error" visible>
              {error}
            </HelperText>
          )}

          <Button
            mode="contained"
            icon={busy ? undefined : "link-variant"}
            disabled={busy || !email.trim() || !password}
            onPress={submit}
            contentStyle={styles.tall}
          >
            {busy ? <ActivityIndicator color="#fff" /> : t("sync.connect")}
          </Button>

          <HelperText type="info" visible>
            {t("sync.passwordNote")}
          </HelperText>
        </Card.Content>
      </Card>

      {/* Said before they connect, not discovered afterwards. Decisions 5 and
          6 take two things away from the lote, and the person who is about to
          press the button is the person who should hear about it. */}
      <Card mode="outlined" style={styles.card}>
        <Card.Title title={t("sync.changesTitle")} />
        <Card.Content>
          <Bullet text={t("sync.changeSettle")} />
          <Bullet text={t("sync.changePlots")} />
          <Bullet text={t("sync.changePrices")} />
        </Card.Content>
      </Card>
    </ScrollView>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bullet}>
      <MaterialCommunityIcons name="circle-medium" size={18} color="#8a5a00" />
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

const roleName = (role: string | null, t: (k: string) => string) =>
  role === "owner" ? t("sync.roleOwner") : role === "admin" ? t("sync.roleAdmin") : t("sync.roleWeigher");

/**
 * Every failure a person can do something about, said in their words.
 *
 * The default is deliberately not "algo salió mal": it carries the code, which
 * is useless to the pesador and is the only thing that helps whoever they call.
 */
function messageFor(e: unknown, t: (k: string, v?: Record<string, string>) => string): string {
  if (!(e instanceof ApiError)) return String((e as Error)?.message ?? e);
  switch (e.code) {
    case "INVALID_CREDENTIALS":
      return t("sync.errBadCredentials");
    case "EMAIL_NOT_VERIFIED":
      return t("sync.errNotVerified");
    case "FARM_SUSPENDED":
      return t("sync.errSuspended");
    case "NETWORK":
    case "TIMEOUT":
      return t("sync.errNoSignal");
    case "FARM_ALREADY_CLAIMED":
      return t("sync.errOtherFarm");
    default:
      return t("sync.errOther", { code: e.code });
  }
}

const styles = StyleSheet.create({
  scroll: { padding: 12, paddingBottom: 32 },
  card: { marginTop: 12 },
  centered: { alignItems: "center", gap: 6, paddingVertical: 8 },
  title: { fontWeight: "700" },
  dim: { opacity: 0.7 },
  button: { marginTop: 12, borderRadius: 12 },
  tall: { height: 52 },
  bullet: { flexDirection: "row", alignItems: "flex-start", gap: 4, paddingVertical: 4 },
  bulletText: { flex: 1, opacity: 0.85 },
});
