import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { getFeed, markRead, type FeedItem } from "@/src/api/notifications";
import { getToken } from "@/src/auth/tokenStore";
import { routeFor } from "@/src/notifications/notificationRoutes";
import { useUiSettings } from "@/src/ui/UiSettingsContext";

const PAGE = 30;

function whenLabel(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const minutes = Math.floor((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return "yesterday";
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Everything the signed-in person was told: the same feed as the web portal's bell. */
export default function NotificationsScreen() {
  const { palette } = useUiSettings();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (beforeId?: number) => {
    const token = await getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const feed = await getFeed(token, { limit: PAGE, beforeId });
      setItems((current) => (beforeId ? [...current, ...feed.items] : feed.items));
      setUnread(feed.unread);
      setMore(feed.items.length === PAGE);
    } catch (e: any) {
      setError(String(e?.message ?? "Could not load notifications."));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load().catch(() => {});
    }, [load]),
  );

  const open = async (item: FeedItem) => {
    const token = await getToken();
    if (token && !item.read) {
      markRead(token, [item.id]).then((r) => setUnread(r.unread)).catch(() => {});
      setItems((current) => current.map((i) => (i.id === item.id ? { ...i, read: true } : i)));
    }
    const route = routeFor(item.link, item.kind);
    if (route) router.push(route as any);
  };

  const readAll = async () => {
    const token = await getToken();
    if (!token) return;
    const r = await markRead(token);
    setUnread(r.unread);
    setItems((current) => current.map((item) => ({ ...item, read: true })));
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: palette.bg }]} edges={["top"]}>
      <View style={[styles.header, { borderBottomColor: palette.border }]}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Text style={[styles.back, { color: palette.primary }]}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, { color: palette.text }]}>Notifications</Text>
        <Pressable onPress={readAll} disabled={!unread} hitSlop={10}>
          <Text style={[styles.readAll, { color: unread ? palette.primary : palette.muted }]}>Mark all read</Text>
        </Pressable>
      </View>
      {error ? <Text style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
      <FlatList
        data={items}
        keyExtractor={(item) => String(item.id)}
        refreshControl={<RefreshControl refreshing={loading && !items.length} onRefresh={() => load()} tintColor={palette.primary} />}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={{ marginTop: 32 }} color={palette.primary} />
          ) : (
            <Text style={[styles.empty, { color: palette.muted }]}>Nothing yet. Steps waiting on you, and shares, appear here.</Text>
          )
        }
        renderItem={({ item }) => {
          const route = routeFor(item.link, item.kind);
          return (
            <Pressable
              onPress={() => open(item)}
              style={[
                styles.item,
                { borderBottomColor: palette.border, backgroundColor: item.read ? palette.panel : palette.panelSoft },
              ]}
            >
              <View style={[styles.dot, { backgroundColor: item.read ? "transparent" : palette.primary }]} />
              <View style={styles.itemText}>
                <Text style={[styles.itemTitle, { color: palette.text }]}>{item.title}</Text>
                {item.body ? <Text style={[styles.itemBody, { color: palette.muted }]}>{item.body}</Text> : null}
                <Text style={[styles.itemWhen, { color: palette.muted }]}>
                  {whenLabel(item.created_at)}
                  {!route && item.link ? " · act on it in ERIS on the web" : ""}
                </Text>
              </View>
            </Pressable>
          );
        }}
        ListFooterComponent={
          more ? (
            <Pressable onPress={() => load(items[items.length - 1]?.id)} style={styles.more} disabled={loading}>
              <Text style={{ color: palette.primary, fontWeight: "700" }}>{loading ? "Loading…" : "Older notifications"}</Text>
            </Pressable>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { fontSize: 15, fontWeight: "700" },
  title: { fontSize: 17, fontWeight: "800" },
  readAll: { fontSize: 13, fontWeight: "700" },
  error: { paddingHorizontal: 16, paddingTop: 10, fontSize: 13 },
  empty: { textAlign: "center", marginTop: 40, paddingHorizontal: 24, fontSize: 14 },
  item: { flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  itemText: { flex: 1 },
  itemTitle: { fontSize: 15, fontWeight: "700" },
  itemBody: { fontSize: 13, marginTop: 2 },
  itemWhen: { fontSize: 11, marginTop: 4 },
  more: { alignItems: "center", paddingVertical: 16 },
});
