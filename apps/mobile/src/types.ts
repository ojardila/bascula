import type { NavigatorScreenParams } from "@react-navigation/native";

// Bottom tabs — the main sections.
export type TabParamList = {
  Home: undefined;
  People: { view?: "pay" } | undefined;
  Crops: undefined;
  Pickup: undefined;
  Reports: undefined;
  Settings: undefined;
};

// Root stack — tabs + the "add" screens pushed on top.
export type RootStackParamList = {
  MainTabs: NavigatorScreenParams<TabParamList> | undefined;
  PeopleAdd: undefined;
  CropAdd: undefined;
  WorkerDetail: { personId: number };
  PayWorker: { personId: number; monday: string };
  Account: { personId: number };
  Adjust: { personId: number; kind: "anticipo" | "deduccion" };
  CropDetail: { cropId: number };
  WeekDetail: { monday: string };
  /** §7.1's chip opens this. Pending, last sync, conflicts, one button. */
  SyncStatus: undefined;
  /** Registering the phone against a farm. §3.1. */
  SyncSetup: undefined;
};
