import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";

import { getToken } from "@/src/auth/tokenStore";
import { isSessionExpiredError } from "@/src/api/client";
import { missionCenterFeed, type Incident } from "@/src/api/incidents";
import { useUiSettings } from "@/src/ui/UiSettingsContext";
import {
  isArcGisNativeAvailable,
  setMissionIncidents,
  startMissionCenterMap,
  supportsMissionCenterMap,
} from "@/src/arcgis/ArcGISNative";

export default function MissionCenterTabScreen() {
  const { palette } = useUiSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState({ NEW: 0, IN_PROGRESS: 0, RESOLVED: 0 });
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  const openArcgisMissionMap = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Session missing. Sign in again.");
      if (!isArcGisNativeAvailable()) {
        throw new Error("ArcGIS native module unavailable in this build.");
      }
      if (!supportsMissionCenterMap()) {
        throw new Error(
          "This app build is missing Mission Center native methods. Rebuild iOS/Android app with latest native code."
        );
      }

      const res = await missionCenterFeed(token);
      const items: Incident[] = res.items ?? [];
      const nextCounts = {
        NEW: items.filter((x) => x.status === "NEW").length,
        IN_PROGRESS: items.filter((x) => x.status === "IN_PROGRESS").length,
        RESOLVED: items.filter((x) => x.status === "RESOLVED").length,
      };
      setCounts(nextCounts);
      setLastSyncedAt(new Date().toISOString());

      const payload = items.map((x) => ({
        id: x.id,
        title: x.title,
        status: x.status,
        latitude: x.latitude,
        longitude: x.longitude,
      }));
      await setMissionIncidents(JSON.stringify(payload));
      await startMissionCenterMap();
    } catch (e: any) {
      if (!isSessionExpiredError(e)) {
        setError(String(e?.message ?? e));
      }
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    openArcgisMissionMap().catch(() => {});
  }, [openArcgisMissionMap]);

  useFocusEffect(
    useCallback(() => {
      openArcgisMissionMap().catch(() => {});
      return () => {};
    }, [openArcgisMissionMap])
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.bg }]}>
      <View style={[styles.panel, { borderColor: palette.border, backgroundColor: palette.panel }]}>
        <Text style={[styles.title, { color: palette.text }]}>Mission Center (ArcGIS)</Text>
        <Text style={[styles.sub, { color: palette.muted }]}>ArcGIS Mission map should open automatically.</Text>
        <Text style={{ color: "#ef4444", fontWeight: "800" }}>NEW: {counts.NEW}</Text>
        <Text style={{ color: "#f59e0b", fontWeight: "800", marginTop: 2 }}>IN_PROGRESS: {counts.IN_PROGRESS}</Text>
        <Text style={{ color: "#22c55e", fontWeight: "800", marginTop: 2 }}>RESOLVED: {counts.RESOLVED}</Text>
        {lastSyncedAt ? (
          <Text style={{ color: palette.muted, marginTop: 8, fontSize: 12 }}>Synced: {lastSyncedAt}</Text>
        ) : null}
        {error ? <Text style={{ color: "#fca5a5", marginTop: 8 }}>{error}</Text> : null}
        <Text style={{ color: palette.muted, marginTop: 12, fontSize: 12 }}>
          {busy ? "Opening ArcGIS map..." : "If map did not open, this build likely needs a native rebuild."}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12 },
  panel: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
  },
  title: { fontSize: 22, fontWeight: "800" },
  sub: { marginTop: 4, marginBottom: 12, fontSize: 13 },
});
