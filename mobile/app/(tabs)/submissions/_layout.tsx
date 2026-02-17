import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function SubmissionsStackLayout() {
  const insets = useSafeAreaInsets();

  return (
    <Stack
      screenOptions={{
        headerTitleAlign: "center",
        headerStatusBarHeight: insets.top,
      }}
    >
      <Stack.Screen name="index" options={{ title: "Submissions" }} />
      <Stack.Screen name="[id]" options={{ title: "Submission" }} />
      <Stack.Screen name="map" options={{ title: "Map Editor" }} />
    </Stack>
  );
}
