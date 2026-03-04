import { useCallback, useEffect, useState } from "react";
import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { Stack, router, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { AppState } from "react-native";
import "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { clearToken, getToken, getTokenExpiryMs, setSessionExpiredNotice } from "@/src/auth/tokenStore";
import AnimatedSplash from "@/src/ui/AnimatedSplash";
import { UiSettingsProvider, useUiSettings } from "@/src/ui/UiSettingsContext";
import { startOfflineSyncLoop, stopOfflineSyncLoop } from "@/src/offline/syncLoop";
import { syncArcgisRuntimeConfig } from "@/src/offline/arcgisRuntimeConfig";

void SplashScreen.preventAutoHideAsync().catch(() => {});

function AppNavigator() {
  const { scheme } = useUiSettings();
  const pathname = usePathname();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const inAuthArea = (path: string) => path.startsWith("/(auth)");

    const check = async () => {
      if (cancelled) return;
      const token = await getToken();
      if (!token) {
        if (!inAuthArea(pathname)) {
          router.replace("/(auth)/login");
        }
        return;
      }
      const expMs = getTokenExpiryMs(token);
      if (expMs == null) return;
      if (Date.now() >= expMs) {
        await clearToken();
        await setSessionExpiredNotice();
        if (!inAuthArea(pathname)) {
          router.replace("/(auth)/login");
        }
        return;
      }
      const msUntilExpire = Math.max(expMs - Date.now(), 0);
      timer = setTimeout(() => {
        check().catch(() => {});
      }, msUntilExpire + 50);
    };

    check().catch(() => {});
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") check().catch(() => {});
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [pathname]);

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

  useEffect(() => {
    startOfflineSyncLoop(12000);
    return () => {
      stopOfflineSyncLoop();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const syncRuntime = async () => {
      try {
        const token = await getToken();
        if (!token || cancelled) return;
        await syncArcgisRuntimeConfig(token);
      } catch {
        // Non-blocking: app can continue with existing cached config.
      }
    };

    syncRuntime().catch(() => {});
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        syncRuntime().catch(() => {});
      }
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
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
