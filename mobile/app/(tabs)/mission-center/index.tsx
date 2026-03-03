import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";

import { getToken } from "@/src/auth/tokenStore";
import { missionCenterFeed, type Incident, type IncidentStatus } from "@/src/api/incidents";
import { isSessionExpiredError } from "@/src/api/client";
import { useUiSettings } from "@/src/ui/UiSettingsContext";

function statusColor(status: IncidentStatus) {
  if (status === "NEW") return "#ef4444";
  if (status === "IN_PROGRESS") return "#f59e0b";
  return "#22c55e";
}

const CA_BOUNDS = {
  minLat: 32.2,
  maxLat: 42.1,
  minLon: -124.5,
  maxLon: -114.0,
};

export default function MissionCenterTabScreen() {
  const { palette } = useUiSettings();
  const [items, setItems] = useState<Incident[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) {
      router.replace("/(auth)/login");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await missionCenterFeed(token);
      setItems(res.items ?? []);
      if ((res.items ?? []).length > 0 && selectedId == null) {
        setSelectedId(res.items[0].id);
      }
    } catch (e: any) {
      if (isSessionExpiredError(e)) return;
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [selectedId]);

  useEffect(() => {
    load().catch(() => {});
    const t = setInterval(() => {
      load().catch(() => {});
    }, 30000);
    return () => clearInterval(t);
  }, [load]);

  const selected = useMemo(() => items.find((x) => x.id === selectedId) ?? null, [items, selectedId]);
  const grouped = useMemo(
    () => ({
      NEW: items.filter((x) => x.status === "NEW").length,
      IN_PROGRESS: items.filter((x) => x.status === "IN_PROGRESS").length,
      RESOLVED: items.filter((x) => x.status === "RESOLVED").length,
    }),
    [items]
  );

  const openInMaps = async (incident: Incident) => {
    const url = `https://maps.apple.com/?ll=${incident.latitude},${incident.longitude}&q=${encodeURIComponent(
      incident.title
    )}`;
    await Linking.openURL(url);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.bg }]}>
      <View style={styles.inner}>
        <Text style={[styles.title, { color: palette.text }]}>Mission Center</Text>
        <Text style={[styles.sub, { color: palette.muted }]}>
          Red=NEW, Yellow=IN_PROGRESS, Green=RESOLVED. Tap an item for details.
        </Text>

        <View style={styles.countRow}>
          <View style={[styles.countCard, { borderColor: palette.border, backgroundColor: palette.panel }]}>
            <Text style={{ color: "#ef4444", fontWeight: "800" }}>NEW</Text>
            <Text style={{ color: palette.text, marginTop: 3 }}>{grouped.NEW}</Text>
          </View>
          <View style={[styles.countCard, { borderColor: palette.border, backgroundColor: palette.panel }]}>
            <Text style={{ color: "#f59e0b", fontWeight: "800" }}>IN_PROGRESS</Text>
            <Text style={{ color: palette.text, marginTop: 3 }}>{grouped.IN_PROGRESS}</Text>
          </View>
          <View style={[styles.countCard, { borderColor: palette.border, backgroundColor: palette.panel }]}>
            <Text style={{ color: "#22c55e", fontWeight: "800" }}>RESOLVED</Text>
            <Text style={{ color: palette.text, marginTop: 3 }}>{grouped.RESOLVED}</Text>
          </View>
        </View>

        <View style={[styles.mapBoard, { borderColor: palette.border, backgroundColor: palette.panel }]}>
          <Text style={{ color: palette.muted, fontSize: 12, marginBottom: 8 }}>
            California Incident Board
          </Text>
          <View style={[styles.mapCanvas, { backgroundColor: palette.panelSoft, borderColor: palette.border }]}>
            {items.map((incident) => {
              const xPct =
                ((incident.longitude - CA_BOUNDS.minLon) / (CA_BOUNDS.maxLon - CA_BOUNDS.minLon)) * 100;
              const yPct =
                (1 - (incident.latitude - CA_BOUNDS.minLat) / (CA_BOUNDS.maxLat - CA_BOUNDS.minLat)) * 100;
              const x = Math.max(2, Math.min(98, xPct));
              const y = Math.max(2, Math.min(98, yPct));
              const selected = selectedId === incident.id;
              return (
                <Pressable
                  key={`pin-${incident.id}`}
                  onPress={() => setSelectedId(incident.id)}
                  style={[
                    styles.pin,
                    {
                      left: `${x}%`,
                      top: `${y}%`,
                      backgroundColor: statusColor(incident.status),
                      borderColor: selected ? "#fff" : "#0b1220",
                      transform: [{ translateX: -8 }, { translateY: -8 }, { scale: selected ? 1.2 : 1 }],
                    },
                  ]}
                />
              );
            })}
          </View>
        </View>

        <View style={[styles.selectedCard, { borderColor: palette.border, backgroundColor: palette.panel }]}>
          <View style={styles.selectedHead}>
            <Text style={[styles.selectedTitle, { color: palette.text }]}>
              {selected ? selected.title : "No incident selected"}
            </Text>
            <Pressable style={[styles.refreshBtn, { borderColor: palette.border }]} onPress={() => load()}>
              <Text style={{ color: palette.text }}>{busy ? "..." : "Refresh"}</Text>
            </Pressable>
          </View>
          {selected ? (
            <>
              <Text style={{ color: palette.muted, marginTop: 4 }}>
                #{selected.id} | {selected.latitude.toFixed(5)}, {selected.longitude.toFixed(5)}
              </Text>
              <Text style={{ color: palette.muted, marginTop: 4 }}>
                Assignee: {selected.assignment?.assignee_name || selected.assignment?.assignee_email || "Unassigned"}
              </Text>
              <View style={styles.selectedActions}>
                <Pressable style={[styles.smallBtn, { borderColor: palette.border }]} onPress={() => openInMaps(selected)}>
                  <Text style={{ color: palette.text, fontWeight: "700" }}>Open Map</Text>
                </Pressable>
                {selected.linked_submission_id ? (
                  <Pressable
                    style={[styles.smallBtn, { borderColor: palette.border }]}
                    onPress={() =>
                      router.push({
                        pathname: "/(tabs)/drafts/[id]",
                        params: { id: String(selected.linked_submission_id) },
                      })
                    }
                  >
                    <Text style={{ color: palette.text, fontWeight: "700" }}>
                      Linked Draft #{selected.linked_submission_id}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </>
          ) : (
            <Text style={{ color: palette.muted, marginTop: 6 }}>{busy ? "Loading..." : "Select an incident."}</Text>
          )}
        </View>

        {err ? (
          <View style={[styles.errBox, { borderColor: "#b91c1c", backgroundColor: "#450a0a" }]}>
            <Text style={{ color: "#fecaca" }}>{err}</Text>
          </View>
        ) : null}

        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => setSelectedId(item.id)}
              style={[
                styles.item,
                { borderColor: palette.border, backgroundColor: selectedId === item.id ? palette.panelSoft : palette.panel },
              ]}
            >
              <View style={styles.itemHead}>
                <Text style={[styles.itemTitle, { color: palette.text }]}>{item.title}</Text>
                <View style={[styles.pinDot, { backgroundColor: statusColor(item.status) }]} />
              </View>
              <Text style={{ color: palette.muted, fontSize: 12 }}>
                #{item.id} | {item.status} | {item.latitude.toFixed(5)}, {item.longitude.toFixed(5)}
              </Text>
            </Pressable>
          )}
          ListEmptyComponent={
            <Text style={{ color: palette.muted, paddingVertical: 20 }}>{busy ? "Loading..." : "No incidents."}</Text>
          }
          contentContainerStyle={{ paddingBottom: 30 }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  inner: { flex: 1, padding: 12 },
  title: { fontSize: 26, fontWeight: "800" },
  sub: { marginTop: 3, marginBottom: 10, fontSize: 12 },
  countRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  countCard: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    alignItems: "center",
  },
  selectedCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  selectedHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  selectedTitle: { fontSize: 15, fontWeight: "700", flexShrink: 1 },
  refreshBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  mapBoard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  mapCanvas: {
    height: 180,
    borderWidth: 1,
    borderRadius: 10,
    position: "relative",
    overflow: "hidden",
  },
  pin: {
    width: 16,
    height: 16,
    borderRadius: 999,
    borderWidth: 1.5,
    position: "absolute",
  },
  selectedActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  smallBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  errBox: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  item: { borderWidth: 1, borderRadius: 12, padding: 10, marginBottom: 8 },
  itemHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  itemTitle: { fontSize: 15, fontWeight: "700", flexShrink: 1 },
  pinDot: { width: 12, height: 12, borderRadius: 999 },
});
