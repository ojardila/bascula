import { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { View, Text, StyleSheet } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { PaperProvider, MD3LightTheme, IconButton } from "react-native-paper";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { initDb } from "./src/db";
import { LangProvider, useT } from "./src/i18n";
import type { RootStackParamList, TabParamList } from "./src/types";
import Home from "./src/screens/Home";
import People from "./src/screens/People";
import PeopleAdd from "./src/screens/PeopleAdd";
import Crops from "./src/screens/Crops";
import CropAdd from "./src/screens/CropAdd";
import RegisterPickup from "./src/screens/RegisterPickup";
import Reports from "./src/screens/Reports";
import Settings from "./src/screens/Settings";
import WorkerDetail from "./src/screens/WorkerDetail";
import PayWorker from "./src/screens/PayWorker";
import Account from "./src/screens/Account";
import Adjust from "./src/screens/Adjust";
import CropDetail from "./src/screens/CropDetail";
import WeekDetail from "./src/screens/WeekDetail";
import SyncStatus from "./src/screens/SyncStatus";
import SyncSetup from "./src/screens/SyncSetup";
import SeasonImport from "./src/screens/SeasonImport";
import SyncChip from "./src/components/SyncChip";
import { SyncProvider } from "./src/sync/SyncProvider";

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

export const theme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: "#2e7d32", // harvest green
    secondary: "#f6b40e", // sun gold
    background: "#f4f7f4",
  },
};

const TAB_ICON: Record<keyof TabParamList, string> = {
  Home: "home-variant",
  People: "account-group",
  Crops: "sprout",
  Pickup: "scale",
  Reports: "chart-bar",
  Settings: "cog",
};

const NAV_KEY: Record<keyof TabParamList, string> = {
  Home: "nav.home",
  People: "nav.workers",
  Crops: "nav.crops",
  Pickup: "nav.pickup",
  Reports: "nav.reports",
  Settings: "nav.settings",
};

function MainTabs() {
  const { t } = useT();
  return (
    <Tab.Navigator
      backBehavior="history"
      screenOptions={({ route, navigation }) => ({
        headerStyle: { backgroundColor: theme.colors.primary },
        headerTintColor: "#fff",
        headerTitleAlign: "center",
        headerLeft: () =>
          navigation.canGoBack() ? (
            <IconButton
              icon="arrow-left"
              iconColor="#fff"
              size={24}
              onPress={() => navigation.goBack()}
              accessibilityLabel={t("nav.back")}
            />
          ) : undefined,
        // §7.1: one chip, in the header, always visible, tappable. The
        // pesador should never have to go looking for the answer to "is my
        // work safe".
        headerRight: () => <SyncChip />,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: "#9aa39a",
        tabBarStyle: {
          height: 64,
          paddingBottom: 8,
          paddingTop: 6,
          borderTopColor: "#e4e9e4",
          backgroundColor: "#ffffff",
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        title: route.name === "Home" ? "⚖️ Báscula" : t(NAV_KEY[route.name]),
        tabBarLabel: t(NAV_KEY[route.name]),
        tabBarIcon: ({ color, size, focused }) => (
          <MaterialCommunityIcons
            name={TAB_ICON[route.name] as any}
            color={color}
            size={focused ? size + 2 : size}
          />
        ),
      })}
    >
      <Tab.Screen name="Home" component={Home} />
      <Tab.Screen name="People" component={People} />
      <Tab.Screen name="Crops" component={Crops} />
      <Tab.Screen
        name="Pickup"
        component={RegisterPickup}
        options={{ title: t("stack.registerPickup") }}
      />
      <Tab.Screen name="Reports" component={Reports} />
      <Tab.Screen name="Settings" component={Settings} />
    </Tab.Navigator>
  );
}

function AppInner() {
  const { t } = useT();
  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.primary },
          headerTintColor: "#fff",
          presentation: "modal",
        }}
      >
        <Stack.Screen name="MainTabs" component={MainTabs} options={{ headerShown: false }} />
        <Stack.Screen name="PeopleAdd" component={PeopleAdd} options={{ title: t("stack.newWorker") }} />
        <Stack.Screen name="CropAdd" component={CropAdd} options={{ title: t("stack.newCrop") }} />
        <Stack.Screen
          name="WorkerDetail"
          component={WorkerDetail}
          options={{ title: t("worker.performance"), presentation: "card" }}
        />
        <Stack.Screen
          name="PayWorker"
          component={PayWorker}
          options={{ title: t("pay.pay"), presentation: "card" }}
        />
        <Stack.Screen
          name="Account"
          component={Account}
          options={{ title: t("pay.account"), presentation: "card" }}
        />
        <Stack.Screen
          name="CropDetail"
          component={CropDetail}
          options={{ title: t("nav.crops"), presentation: "card" }}
        />
        <Stack.Screen
          name="WeekDetail"
          component={WeekDetail}
          options={{ title: t("reports.week"), presentation: "card" }}
        />
        <Stack.Screen
          name="Adjust"
          component={Adjust}
          options={{ title: t("pay.newMovement"), presentation: "card" }}
        />
        <Stack.Screen
          name="SyncStatus"
          component={SyncStatus}
          options={{ title: t("stack.sync"), presentation: "card" }}
        />
        <Stack.Screen
          name="SyncSetup"
          component={SyncSetup}
          options={{ title: t("stack.syncSetup"), presentation: "card" }}
        />
        <Stack.Screen
          name="SeasonImport"
          component={SeasonImport}
          options={{ title: t("stack.seasonImport"), presentation: "card" }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

function DbError({ message }: { message: string }) {
  return (
    <View style={errorStyles.wrap}>
      <MaterialCommunityIcons name="database-alert" size={48} color="#b3261e" />
      <Text style={errorStyles.title}>No se pudo abrir la base de datos</Text>
      <Text style={errorStyles.body}>{message}</Text>
    </View>
  );
}

const errorStyles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  title: { fontSize: 18, fontWeight: "700", textAlign: "center" },
  body: { opacity: 0.7, textAlign: "center" },
});

export default function App() {
  const [dbError, setDbError] = useState<string | null>(null);

  useEffect(() => {
    // A failed migration must never leave the app unable to start with the
    // money database inside it.
    try {
      initDb();
    } catch (e) {
      setDbError(String(e));
    }
  }, []);

  return (
    <SafeAreaProvider>
      <LangProvider>
        <PaperProvider
          theme={theme}
          settings={{
            icon: (props) => <MaterialCommunityIcons {...(props as any)} />,
          }}
        >
          <StatusBar style="light" />
          {dbError ? (
            <DbError message={dbError} />
          ) : (
            // Inside the error guard: the provider opens the secrets table on
            // the same connection, so a database that would not migrate must
            // reach the error screen rather than take this down with it.
            <SyncProvider>
              <AppInner />
            </SyncProvider>
          )}
        </PaperProvider>
      </LangProvider>
    </SafeAreaProvider>
  );
}
