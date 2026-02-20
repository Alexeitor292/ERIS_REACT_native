import { Stack } from "expo-router";
import { Platform } from "react-native";
export default function SubmissionsStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerTitleAlign: "center",
        headerBackTitleVisible: false,
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
      <Stack.Screen
        name="index"
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen name="[id]" options={{ title: "Submission" }} />
      <Stack.Screen name="map" options={{ title: "Map Editor" }} />
    </Stack>
  );
}
