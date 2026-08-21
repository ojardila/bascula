import { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { PaperProvider, MD3LightTheme } from "react-native-paper";
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
      screenOptions={({ route }) => ({
        headerStyle: { backgroundColor: theme.colors.primary },
        headerTintColor: "#fff",
        headerTitleAlign: "center",
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
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  useEffect(() => {
    initDb();
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
          <AppInner />
        </PaperProvider>
      </LangProvider>
    </SafeAreaProvider>
  );
}
