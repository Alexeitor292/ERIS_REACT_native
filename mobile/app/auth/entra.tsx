import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";

import { getToken } from "../../src/auth/tokenStore";

// The Entra redirect (com.juancampos.eris.mobile://auth/entra) lands here when
// the operating system routes it into the app (Android Custom Tabs). The sign-in
// screen that opened the browser receives the same URL and finishes the
// exchange; this screen only hands control back to it, then moves on.
WebBrowser.maybeCompleteAuthSession();

export default function EntraRedirect() {
  useEffect(() => {
    const timer = setTimeout(async () => {
      const token = await getToken().catch(() => null);
      router.replace(token ? "/(tabs)/incidents/track" : "/(auth)/login");
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
      <ActivityIndicator />
    </View>
  );
}
