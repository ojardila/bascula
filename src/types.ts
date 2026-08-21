import type { NavigatorScreenParams } from "@react-navigation/native";

// Bottom tabs — the main sections.
export type TabParamList = {
  Home: undefined;
  People: undefined;
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
};
