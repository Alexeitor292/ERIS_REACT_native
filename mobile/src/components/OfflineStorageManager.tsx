/**
 * Offline 3D area storage management.
 *
 * Lists all downloaded scene packages, shows per-area size/age/status, allows
 * deleting an individual area, and clearing stale packages. Embedded in Settings.
 */
import React, { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert } from "react-native";

import { formatBytes, formatPackageAge, isStale, summarizeStorage, type OfflineScenePackageMeta } from "../arcgis/offlineScene";
import {
  clearStalePackages,
  deleteOfflineScenePackage,
  listOfflineScenePackages,
} from "../offline/offlineScenePackages";

const STALE_DAYS = 60;

type Palette = { text: string; muted: string; border: string; panel: string };

export function OfflineStorageManager({ palette }: { palette: Palette }) {
  const [items, setItems] = useState<OfflineScenePackageMeta[]>([]);

  const reload = useCallback(async () => {
    setItems(await listOfflineScenePackages());
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const onDelete = useCallback(
    (submissionId: number) => {
      Alert.alert("Delete offline area", `Remove the downloaded 3D package for submission #${submissionId}?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            await deleteOfflineScenePackage(submissionId);
            await reload();
          },
        },
      ]);
    },
    [reload],
  );

  const onClearStale = useCallback(async () => {
    const removed = await clearStalePackages(STALE_DAYS);
    await reload();
    Alert.alert("Stale packages", removed.length ? `Removed ${removed.length} package(s) older than ${STALE_DAYS} days.` : "No stale packages to remove.");
  }, [reload]);

  const summary = summarizeStorage(items);

  return (
    <View>
      <Text style={[styles.summary, { color: palette.muted }]}>
        {summary.readyCount} downloaded · {formatBytes(summary.totalBytes)} total
      </Text>

      {items.length === 0 ? (
        <Text style={[styles.empty, { color: palette.muted }]}>No offline 3D areas downloaded yet.</Text>
      ) : (
        items.map((m) => (
          <View key={m.submissionId} style={[styles.itemRow, { borderColor: palette.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.itemTitle, { color: palette.text }]}>
                Submission #{m.submissionId}
                {isStale(m, STALE_DAYS) ? "  · stale" : ""}
              </Text>
              <Text style={[styles.itemMeta, { color: palette.muted }]}>
                {m.status} · {formatBytes(m.sizeBytes)} · {formatPackageAge(m.downloadedAt)}
              </Text>
            </View>
            <Pressable onPress={() => onDelete(m.submissionId)} style={styles.deleteBtn}>
              <Text style={styles.deleteText}>Delete</Text>
            </Pressable>
          </View>
        ))
      )}

      <Pressable onPress={onClearStale} style={[styles.clearBtn, { borderColor: palette.border }]}>
        <Text style={[styles.clearText, { color: palette.text }]}>Clear stale ({">"} {STALE_DAYS} days)</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { fontSize: 12, marginBottom: 8 },
  empty: { fontSize: 12, fontStyle: "italic", marginBottom: 8 },
  itemRow: { flexDirection: "row", alignItems: "center", borderTopWidth: 1, paddingVertical: 8, gap: 8 },
  itemTitle: { fontSize: 13, fontWeight: "600" },
  itemMeta: { fontSize: 11, marginTop: 2 },
  deleteBtn: { backgroundColor: "#7f1d1d", borderRadius: 5, paddingHorizontal: 10, paddingVertical: 6 },
  deleteText: { color: "#fff", fontSize: 11, fontWeight: "600" },
  clearBtn: { marginTop: 10, borderWidth: 1, borderRadius: 6, paddingVertical: 8, alignItems: "center" },
  clearText: { fontSize: 12, fontWeight: "600" },
});
