import { useCallback, useEffect, useState } from "react";
import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import AnimatedSplash from "@/src/ui/AnimatedSplash";
import { UiSettingsProvider, useUiSettings } from "@/src/ui/UiSettingsContext";

void SplashScreen.preventAutoHideAsync().catch(() => {});

function AppNavigator() {
  const { scheme } = useUiSettings();

  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: "modal", title: "Modal" }} />
      </Stack>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);
  const [showAnimatedSplash, setShowAnimatedSplash] = useState(true);

  useEffect(() => {
    const boot = async () => {
      setIsReady(true);
      await SplashScreen.hideAsync().catch(() => {});
    };
    boot().catch(() => {});
  }, []);

  const onSplashDone = useCallback(() => {
    setShowAnimatedSplash(false);
  }, []);

  if (!isReady) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <UiSettingsProvider>
          <AppNavigator />
          {showAnimatedSplash ? <AnimatedSplash onDone={onSplashDone} /> : null}
        </UiSettingsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
