import { Stack } from "expo-router";
import { Platform } from "react-native";

export default function DraftsStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerTitleAlign: "center",
        ...(Platform.OS === "ios"
          ? {
              headerBackButtonDisplayMode: "minimal" as const,
              headerShadowVisible: false,
              headerLargeTitleShadowVisible: false,
              headerTransparent: false,
            }
          : {}),
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="[id]" options={{ title: "Draft" }} />
    </Stack>
  );
}
